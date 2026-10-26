import { useEffect, useState, useRef } from 'react';
import {
  StyleSheet, Text, View, ScrollView, TouchableOpacity,
  Alert, Platform, ActivityIndicator, TextInput,
  KeyboardAvoidingView,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { StatusBar } from 'expo-status-bar';

// ============================================================
// 設定
// ============================================================
const VAPID_PUBLIC_KEY = 'BDOSbrULqMeiPPv-3mmz9-POH7jz2nWrIPFnrTdAHyhyHev6L1ql3c92-W-Odug3uJKZ9VLhowaJ9dveYBm7jCY';
const BASE_PATH = '/kitchencar-monitor';
const GIST_ID = '26a2b414b79333a12e636f1d2a648d07';
const GIST_FILE = 'sites.json';

const IS_WEB = Platform.OS === 'web';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
  }),
});

// ============================================================
// Web Push ユーティリティ
// ============================================================
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

function isIosDevice() {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  // 旧来の判定
  if (/iPad|iPhone|iPod/.test(ua)) return true;
  // iPadOS 13+ は Macintosh を名乗るがタッチ対応
  if (/Macintosh/.test(ua) && typeof document !== 'undefined' && 'ontouchend' in document) return true;
  // iOS 26+ で UA が変わっても CPU iPhone/iPad OS の部分で検出
  if (/CPU (?:iPhone )?OS \d+/.test(ua)) return true;
  return false;
}

function getIosVersion() {
  if (typeof navigator === 'undefined') return null;
  const m = navigator.userAgent.match(/OS (\d+)[._](\d+)(?:[._](\d+))?/);
  if (!m) return null;
  return {
    major: parseInt(m[1], 10),
    minor: parseInt(m[2], 10),
    patch: m[3] ? parseInt(m[3], 10) : 0,
  };
}

function isStandalonePwa() {
  if (typeof window === 'undefined') return false;
  return (
    window.matchMedia?.('(display-mode: standalone)').matches ||
    window.navigator.standalone === true
  );
}

function webSupportStatus() {
  // { ok, code, message }
  if (typeof window === 'undefined') {
    return { ok: false, code: 'no_window', message: 'ブラウザ環境ではありません。' };
  }
  // iOS の場合はバージョン & スタンドアロン起動を最優先でチェック
  // （iOS Safari はスタンドアロン起動時のみ PushManager を露出するため）
  if (isIosDevice()) {
    const iosVer = getIosVersion();
    if (iosVer && (iosVer.major < 16 || (iosVer.major === 16 && iosVer.minor < 4))) {
      return {
        ok: false,
        code: 'ios_too_old',
        message: `iOS ${iosVer.major}.${iosVer.minor} では Web Push 非対応です。iOS 16.4 以上にアップデートしてください。`,
      };
    }
    if (!isStandalonePwa()) {
      return {
        ok: false,
        code: 'not_standalone',
        message: 'iOSでは「ホーム画面に追加」してから、ホーム画面のアイコンで起動した時だけ通知が使えます。\n\n手順：\n① Safari画面下の共有ボタン（□↑）\n② 「ホーム画面に追加」\n③ ホーム画面の「出店モニター」アイコンをタップ',
      };
    }
  }
  if (!('serviceWorker' in navigator)) {
    return { ok: false, code: 'no_sw', message: 'このブラウザは Service Worker 非対応です。' };
  }
  if (!('PushManager' in window)) {
    return { ok: false, code: 'no_push', message: 'このブラウザは Web Push 非対応です。Safari/Chrome の最新版でお試しください。' };
  }
  if (!('Notification' in window)) {
    return { ok: false, code: 'no_notification', message: 'このブラウザは Notification API 非対応です。' };
  }
  return { ok: true };
}

async function sendSubscriptionToPc(sub) {
  try {
    const pcIp = await AsyncStorage.getItem('pcIp');
    if (!pcIp) return { ok: false, reason: 'PC IP未設定' };
    const res = await fetch(`http://${pcIp}:8080/subscriptions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sub.toJSON()),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e.message || String(e) };
  }
}

async function registerSwAndSubscribeWeb() {
  const support = webSupportStatus();
  if (!support.ok) throw new Error(support.message);

  // Service Worker 登録
  let reg;
  try {
    reg = await navigator.serviceWorker.register(`${BASE_PATH}/sw.js`, { scope: `${BASE_PATH}/` });
  } catch (e) {
    throw new Error('Service Worker の登録に失敗しました: ' + (e.message || e));
  }
  await navigator.serviceWorker.ready;

  // 通知許可 (ユーザー操作直後の呼び出し)
  let perm = Notification.permission;
  if (perm === 'default') {
    perm = await Notification.requestPermission();
  }
  if (perm === 'denied') {
    throw new Error('通知が拒否されています。iOSの「設定 > 通知」または Safari の設定で許可してください。');
  }
  if (perm !== 'granted') {
    throw new Error('通知許可が得られませんでした。');
  }

  // 既存購読を取得、なければ新規購読
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    try {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
      });
    } catch (e) {
      throw new Error('Push 購読に失敗しました: ' + (e.message || e));
    }
  }
  return sub;
}

// ============================================================
// ネイティブ (Expo) 用
// ============================================================
async function registerForPushExpo() {
  if (!Device.isDevice) {
    throw new Error('シミュレータでは取得できません。実機で起動してください。');
  }
  const { status: existing } = await Notifications.getPermissionsAsync();
  let finalStatus = existing;
  if (existing !== 'granted') {
    const { status } = await Notifications.requestPermissionsAsync();
    finalStatus = status;
  }
  if (finalStatus !== 'granted') {
    throw new Error('通知が許可されていません。設定アプリで通知を許可してください。');
  }
  const { data } = await Notifications.getExpoPushTokenAsync();
  return data;
}

// ============================================================
// 通知タブ
// ============================================================
function NotifTab() {
  const [token, setToken] = useState(null);
  const [subscription, setSubscription] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);
  const [logs, setLogs] = useState([]);
  const notifRef = useRef();
  const respRef = useRef();
  const [support, setSupport] = useState(IS_WEB ? webSupportStatus() : { ok: true });

  useEffect(() => {
    // 既存の購読があれば復元 (Web)
    if (IS_WEB && support.ok && 'serviceWorker' in navigator) {
      navigator.serviceWorker.getRegistration().then(async (reg) => {
        if (!reg) return;
        const sub = await reg.pushManager.getSubscription();
        if (sub) setSubscription(sub);
      }).catch(() => {});
    }

    // ネイティブは従来通りリスナーだけ登録
    if (!IS_WEB) {
      notifRef.current = Notifications.addNotificationReceivedListener(n => {
        const { title, body } = n.request.content;
        setLogs(prev => [{ title, body, at: new Date().toLocaleString('ja-JP') }, ...prev].slice(0, 30));
      });
      respRef.current = Notifications.addNotificationResponseReceivedListener(r => {
        const { title, body } = r.notification.request.content;
        Alert.alert(title || '通知', body || '');
      });
    }

    return () => {
      notifRef.current?.remove?.();
      respRef.current?.remove?.();
    };
  }, []);

  async function enableNotifications() {
    setErr(null);
    setLoading(true);
    try {
      if (IS_WEB) {
        const sub = await registerSwAndSubscribeWeb();
        setSubscription(sub);
        // PC が同じWi-Fiにいれば自動送信
        const r = await sendSubscriptionToPc(sub);
        if (r.ok) {
          Alert.alert('登録完了', 'PCに購読情報を自動送信しました。');
        }
      } else {
        const t = await registerForPushExpo();
        setToken(t);
      }
    } catch (e) {
      setErr(e.message || String(e));
    } finally {
      setLoading(false);
      if (IS_WEB) setSupport(webSupportStatus());
    }
  }

  async function copyToken() {
    const payload = IS_WEB
      ? (subscription ? JSON.stringify(subscription.toJSON(), null, 2) : '')
      : (token || '');
    if (!payload) return;
    await Clipboard.setStringAsync(payload);
    if (IS_WEB) {
      Alert.alert('コピーしました', 'Mac で「購読を登録」の手順を実行してください。');
    } else {
      Alert.alert('コピーしました', 'PC の config.json の "expo_push_token" に貼り付けてください。');
    }
  }

  async function disableNotifications() {
    // 2026-10-26: 旧購読の明示的な解除（Push API unsubscribe）。Mac側の控えは次回送信時の404/410で自動整理される
    setErr(null);
    setLoading(true);
    try {
      if (IS_WEB) {
        const reg = await navigator.serviceWorker.getRegistration();
        const sub = reg ? await reg.pushManager.getSubscription() : null;
        if (sub) {
          const ok = await sub.unsubscribe();
          if (!ok) throw new Error('購読の解除に失敗しました。');
        }
        setSubscription(null);
        Alert.alert('解除しました', 'この端末のPush購読を解除しました。再び受け取るには「通知を有効にする」を押してください。');
      }
    } catch (e) {
      setErr(e.message || String(e));
    } finally {
      setLoading(false);
    }
  }

  const hasCredential = IS_WEB ? !!subscription : !!token;
  const displayText = IS_WEB
    ? (subscription ? JSON.stringify(subscription.toJSON(), null, 2) : '')
    : (token || '');

  return (
    <ScrollView contentContainerStyle={s.scroll}>
      <View style={s.card}>
        <Text style={s.cardTitle}>Push 通知設定</Text>

        {IS_WEB && !support.ok && (
          <View style={s.errBox}>
            <Text style={s.errTitle}>
              {support.code === 'not_standalone' ? '📲 ホーム画面に追加してください' : '⚠ 利用できません'}
            </Text>
            <Text style={s.errMsg}>{support.message}</Text>
          </View>
        )}

        {!hasCredential && (
          <>
            <Text style={s.hint}>
              {IS_WEB
                ? '下のボタンをタップして通知を有効化してください。（ボタンタップ直後でないとiOSは許可ダイアログを出しません）'
                : '下のボタンで通知許可をリクエストし、Push Token を取得します。'}
            </Text>
            <TouchableOpacity
              style={[s.btn, (loading || (IS_WEB && !support.ok)) && { opacity: 0.5 }]}
              onPress={enableNotifications}
              disabled={loading || (IS_WEB && !support.ok)}
            >
              <Text style={s.btnText}>
                {loading ? '処理中...' : '🔔 通知を有効にする'}
              </Text>
            </TouchableOpacity>
          </>
        )}

        {err && (
          <View style={s.errBox}>
            <Text style={s.errTitle}>エラー</Text>
            <Text style={s.errMsg}>{err}</Text>
          </View>
        )}

        {hasCredential && (
          <>
            <Text style={s.cardSubTitle}>
              {IS_WEB ? 'Web Push Subscription' : 'Expo Push Token'}
            </Text>
            <Text style={s.token} selectable>{displayText}</Text>
            <TouchableOpacity style={s.btn} onPress={copyToken}>
              <Text style={s.btnText}>
                {IS_WEB ? 'Subscription をコピー' : 'トークンをコピー'}
              </Text>
            </TouchableOpacity>
            <Text style={s.hint}>
              {IS_WEB
                ? 'コピーしたら Mac で「購読を登録」の手順を実行してください（ユニバーサルクリップボードで Mac に貼り付けできます）。'
                : 'PC の config.json の "expo_push_token" に貼り付けてください。'}
            </Text>
            {IS_WEB && (
              <TouchableOpacity
                style={[s.btn, { backgroundColor: '#999' }, loading && { opacity: 0.5 }]}
                onPress={disableNotifications}
                disabled={loading}
              >
                <Text style={s.btnText}>{loading ? '処理中...' : '🔕 この端末の購読を解除する'}</Text>
              </TouchableOpacity>
            )}
          </>
        )}
      </View>

      {!IS_WEB && (
        <View style={s.card}>
          <Text style={s.cardTitle}>受信した通知</Text>
          {logs.length === 0
            ? <Text style={s.empty}>まだ通知はありません</Text>
            : logs.map((l, i) => (
              <View key={i} style={s.logItem}>
                <Text style={s.logTitle}>{l.title}</Text>
                <Text style={s.logBody}>{l.body}</Text>
                <Text style={s.logTime}>{l.at}</Text>
              </View>
            ))
          }
        </View>
      )}

      {IS_WEB && (
        <View style={s.card}>
          <Text style={s.cardTitle}>診断情報</Text>
          <Text style={s.diag}>Platform: Web</Text>
          <Text style={s.diag}>iOS: {isIosDevice() ? 'Yes' : 'No'}</Text>
          <Text style={s.diag}>iOSバージョン: {(() => { const v = getIosVersion(); return v ? `${v.major}.${v.minor}` : '不明'; })()}</Text>
          <Text style={s.diag}>スタンドアロン(PWA): {isStandalonePwa() ? 'Yes' : 'No'}</Text>
          <Text style={s.diag}>Service Worker: {('serviceWorker' in (typeof navigator !== 'undefined' ? navigator : {})) ? '対応' : '非対応'}</Text>
          <Text style={s.diag}>Push API: {(typeof window !== 'undefined' && 'PushManager' in window) ? '対応' : '非対応'}</Text>
          <Text style={s.diag}>通知権限: {typeof Notification !== 'undefined' ? Notification.permission : '不明'}</Text>
        </View>
      )}
    </ScrollView>
  );
}

// ============================================================
// Gist ユーティリティ
// ============================================================
async function gistFetchSites() {
  // 認証なしで公開Gistから読み取り（キャッシュ回避）
  const url = `https://gist.githubusercontent.com/monamnis-ui/${GIST_ID}/raw/${GIST_FILE}?t=${Date.now()}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`読み取り失敗 HTTP ${res.status}`);
  const text = await res.text();
  try {
    const data = JSON.parse(text);
    if (Array.isArray(data)) return data;
    return [];
  } catch {
    return [];
  }
}

async function gistWriteSites(sites, pat) {
  if (!pat) throw new Error('GitHub Personal Access Token が未設定です');
  const res = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${pat}`,
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      files: { [GIST_FILE]: { content: JSON.stringify(sites, null, 2) } },
    }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`書込失敗 HTTP ${res.status}: ${errText.slice(0, 120)}`);
  }
}

// ============================================================
// サイト管理タブ
// ============================================================
function SitesTab() {
  const [pat, setPat] = useState('');
  const [patInput, setPatInput] = useState('');
  const [patSaved, setPatSaved] = useState(false);
  const [sites, setSites] = useState([]);
  const [fetching, setFetching] = useState(false);
  const [newName, setNewName] = useState('');
  const [newUrl, setNewUrl] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    AsyncStorage.getItem('ghPat').then(p => {
      if (p) { setPat(p); setPatSaved(true); }
    });
    fetchSites();
  }, []);

  async function savePat() {
    const v = patInput.trim();
    if (!v) return;
    await AsyncStorage.setItem('ghPat', v);
    setPat(v);
    setPatSaved(true);
    setPatInput('');
    Alert.alert('保存しました', 'GitHub Token を保存しました。');
  }

  async function clearPat() {
    await AsyncStorage.removeItem('ghPat');
    setPat('');
    setPatSaved(false);
  }

  async function fetchSites() {
    setFetching(true);
    try {
      const data = await gistFetchSites();
      setSites(data);
    } catch (e) {
      Alert.alert('取得失敗', e.message || String(e));
    } finally {
      setFetching(false);
    }
  }

  function deleteSite(idx) {
    if (!pat) {
      Alert.alert('Token未設定', 'サイト編集には GitHub Token が必要です。');
      return;
    }
    Alert.alert('削除確認', `「${sites[idx].name}」を削除しますか？`, [
      { text: 'キャンセル', style: 'cancel' },
      {
        text: '削除', style: 'destructive', onPress: async () => {
          setBusy(true);
          try {
            const next = sites.filter((_, i) => i !== idx);
            await gistWriteSites(next, pat);
            setSites(next);
          } catch (e) {
            Alert.alert('エラー', e.message || String(e));
          } finally {
            setBusy(false);
          }
        },
      },
    ]);
  }

  async function addSite() {
    if (!pat) {
      Alert.alert('Token未設定', 'サイト追加には GitHub Token が必要です。');
      return;
    }
    if (!newName.trim() || !newUrl.trim()) {
      Alert.alert('入力エラー', 'サイト名とURLを入力してください。');
      return;
    }
    if (!newUrl.trim().startsWith('http')) {
      Alert.alert('URLエラー', 'URL は http:// または https:// で始めてください。');
      return;
    }
    setBusy(true);
    try {
      const next = [...sites, { name: newName.trim(), url: newUrl.trim() }];
      await gistWriteSites(next, pat);
      setSites(next);
      setNewName('');
      setNewUrl('');
    } catch (e) {
      Alert.alert('エラー', e.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={s.scroll}>

        <View style={s.card}>
          <Text style={s.cardTitle}>GitHub 設定</Text>
          <Text style={s.hint}>
            サイト一覧を Gist でクラウド同期します。編集するには Personal Access Token が必要です（読み取りのみなら不要）。
            {'\n\n'}
            取得方法：GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token
            {'\n'}
            Permissions: Gists → Read and write
          </Text>
          {patSaved ? (
            <>
              <Text style={s.diag}>✓ Token 登録済み</Text>
              <TouchableOpacity style={[s.btn, { backgroundColor: '#888' }]} onPress={clearPat}>
                <Text style={s.btnText}>Token をクリア</Text>
              </TouchableOpacity>
            </>
          ) : (
            <>
              <TextInput
                style={s.input}
                placeholder="github_pat_... または ghp_..."
                placeholderTextColor="#bbb"
                value={patInput}
                onChangeText={setPatInput}
                autoCapitalize="none"
                secureTextEntry
              />
              <TouchableOpacity style={s.btn} onPress={savePat}>
                <Text style={s.btnText}>Token を保存</Text>
              </TouchableOpacity>
            </>
          )}
        </View>

        <View style={s.card}>
          <View style={[s.row, { marginBottom: 12 }]}>
            <Text style={[s.cardTitle, { flex: 1, marginBottom: 0 }]}>
              監視サイト一覧（{sites.length}件）
            </Text>
            <TouchableOpacity onPress={fetchSites} disabled={fetching}>
              <Text style={{ color: '#ff6b00', fontSize: 13 }}>
                {fetching ? '更新中...' : '更新'}
              </Text>
            </TouchableOpacity>
          </View>
          {fetching && <ActivityIndicator color="#ff6b00" />}
          {!fetching && sites.length === 0 && (
            <Text style={s.empty}>サイトがありません</Text>
          )}
          {sites.map((site, i) => (
            <View key={i} style={s.siteItem}>
              <View style={{ flex: 1 }}>
                <Text style={s.siteName}>{site.name}</Text>
                <Text style={s.siteUrl} numberOfLines={1}>{site.url}</Text>
              </View>
              <TouchableOpacity onPress={() => deleteSite(i)} style={s.deleteBtn} disabled={busy}>
                <Text style={s.deleteBtnText}>削除</Text>
              </TouchableOpacity>
            </View>
          ))}
        </View>

        <View style={s.card}>
          <Text style={s.cardTitle}>サイトを追加</Text>
          <TextInput
            style={s.input}
            placeholder="サイト名（例: 名古屋市イベント）"
            placeholderTextColor="#bbb"
            value={newName}
            onChangeText={setNewName}
          />
          <TextInput
            style={[s.input, { marginTop: 8 }]}
            placeholder="URL（https://...）"
            placeholderTextColor="#bbb"
            value={newUrl}
            onChangeText={setNewUrl}
            autoCapitalize="none"
            keyboardType="url"
          />
          <TouchableOpacity
            style={[s.btn, (busy || !pat) && { opacity: 0.5 }]}
            onPress={addSite}
            disabled={busy || !pat}
          >
            <Text style={s.btnText}>{busy ? '処理中...' : 'サイトを追加'}</Text>
          </TouchableOpacity>
        </View>

      </ScrollView>
    </KeyboardAvoidingView>
  );
}

// ============================================================
// メインアプリ
// ============================================================
export default function App() {
  const [tab, setTab] = useState('notif');

  // Web のときは manifest を動的に挿入
  useEffect(() => {
    if (!IS_WEB || typeof document === 'undefined') return;
    if (!document.querySelector('link[rel="manifest"]')) {
      const link = document.createElement('link');
      link.rel = 'manifest';
      link.href = `${BASE_PATH}/manifest.webmanifest`;
      document.head.appendChild(link);
    }
    if (!document.querySelector('meta[name="apple-mobile-web-app-capable"]')) {
      const m1 = document.createElement('meta');
      m1.name = 'apple-mobile-web-app-capable';
      m1.content = 'yes';
      document.head.appendChild(m1);
      const m2 = document.createElement('meta');
      m2.name = 'apple-mobile-web-app-status-bar-style';
      m2.content = 'black-translucent';
      document.head.appendChild(m2);
      const m3 = document.createElement('meta');
      m3.name = 'apple-mobile-web-app-title';
      m3.content = '出店モニター';
      document.head.appendChild(m3);
    }
  }, []);

  return (
    <View style={s.root}>
      <StatusBar style="light" />
      <View style={s.header}>
        <Text style={s.hTitle}>出店募集モニター</Text>
        <Text style={s.hSub}>キッチンカー・飲食テント</Text>
      </View>

      <View style={s.tabBar}>
        <TouchableOpacity
          style={[s.tabBtn, tab === 'notif' && s.tabActive]}
          onPress={() => setTab('notif')}
        >
          <Text style={[s.tabText, tab === 'notif' && s.tabTextActive]}>通知</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[s.tabBtn, tab === 'sites' && s.tabActive]}
          onPress={() => setTab('sites')}
        >
          <Text style={[s.tabText, tab === 'sites' && s.tabTextActive]}>サイト管理</Text>
        </TouchableOpacity>
      </View>

      <View style={{ flex: 1 }}>
        {tab === 'notif' ? <NotifTab /> : <SitesTab />}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#f5f5f5' },
  header: {
    backgroundColor: '#ff6b00',
    paddingTop: 60,
    paddingBottom: 16,
    paddingHorizontal: 20,
  },
  hTitle: { color: '#fff', fontSize: 22, fontWeight: 'bold' },
  hSub: { color: '#ffe0cc', fontSize: 13, marginTop: 2 },
  tabBar: {
    flexDirection: 'row',
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#eee',
  },
  tabBtn: { flex: 1, paddingVertical: 12, alignItems: 'center' },
  tabActive: { borderBottomWidth: 2, borderBottomColor: '#ff6b00' },
  tabText: { fontSize: 14, color: '#999' },
  tabTextActive: { color: '#ff6b00', fontWeight: '600' },
  scroll: { padding: 16, gap: 16 },
  card: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.08,
    shadowRadius: 4,
    elevation: 2,
  },
  cardTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: '#333',
    marginBottom: 12,
    borderLeftWidth: 3,
    borderLeftColor: '#ff6b00',
    paddingLeft: 8,
  },
  cardSubTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: '#555',
    marginTop: 12,
    marginBottom: 6,
  },
  token: {
    fontSize: 11,
    color: '#555',
    backgroundColor: '#f8f8f8',
    padding: 10,
    borderRadius: 8,
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
    lineHeight: 18,
  },
  btn: {
    backgroundColor: '#ff6b00',
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
    marginTop: 12,
  },
  btnText: { color: '#fff', fontWeight: '600', fontSize: 14 },
  hint: { fontSize: 12, color: '#888', marginBottom: 8, lineHeight: 18 },
  err: { color: '#e53e3e', fontSize: 13, lineHeight: 20 },
  errBox: {
    backgroundColor: '#fff5f5',
    borderWidth: 1,
    borderColor: '#fecaca',
    borderRadius: 8,
    padding: 10,
    marginTop: 8,
  },
  errTitle: { color: '#c53030', fontSize: 13, fontWeight: '700', marginBottom: 4 },
  errMsg: { color: '#7f1d1d', fontSize: 12, lineHeight: 18 },
  diag: { fontSize: 12, color: '#555', marginBottom: 4, fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace' },
  empty: { color: '#999', fontSize: 13, textAlign: 'center', paddingVertical: 12 },
  logItem: { borderBottomWidth: 1, borderBottomColor: '#f0f0f0', paddingVertical: 10 },
  logTitle: { fontSize: 14, fontWeight: '600', color: '#333' },
  logBody: { fontSize: 12, color: '#555', marginTop: 3, lineHeight: 18 },
  logTime: { fontSize: 11, color: '#aaa', marginTop: 4 },
  row: { flexDirection: 'row', alignItems: 'center' },
  input: {
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 8,
    padding: 10,
    fontSize: 14,
    color: '#333',
    backgroundColor: '#fafafa',
  },
  siteItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0',
  },
  siteName: { fontSize: 13, fontWeight: '600', color: '#333' },
  siteUrl: { fontSize: 11, color: '#999', marginTop: 2 },
  deleteBtn: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: '#fee',
    borderRadius: 6,
    marginLeft: 8,
  },
  deleteBtnText: { color: '#e53e3e', fontSize: 12, fontWeight: '600' },
});
