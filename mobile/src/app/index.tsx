import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { DashboardState, fetchDashboard } from '../services/dashboard';
import { useAuth } from '../services/auth';
import {
  fetchAccess,
  controlEngine,
  controlKillSwitch,
  AccessStatus,
} from '../services/settings';

const C = {
  bg: '#10181D',
  card: '#19242B',
  border: '#293840',
  text: '#F3F7F8',
  muted: '#91A1A9',
  green: '#4CC39A',
  red: '#F07878',
  amber: '#E9B96E',
};

function money(value?: number) {
  if (value === undefined || !Number.isFinite(value)) return '—';
  return value.toFixed(2);
}

function Metric({ label, value, color = C.text }: {
  label: string;
  value: string;
  color?: string;
}) {
  return (
    <View style={styles.metric}>
      <Text style={styles.metricLabel}>{label}</Text>
      <Text style={[styles.metricValue, { color }]}>{value}</Text>
    </View>
  );
}

function Section({ title, children }: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <View style={styles.card}>{children}</View>
    </View>
  );
}

export default function HomeScreen() {
  const [data, setData] = useState<DashboardState | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [access, setAccess] = useState<AccessStatus | null>(null);
  const [controlBusy, setControlBusy] = useState(false);
  const { user, signOut } = useAuth();

  const refresh = useCallback(async () => {
    try {
      const permission = await fetchAccess();
      setAccess(permission);
    } catch {
      setAccess(null);
    }

    try {
      const result = await fetchDashboard();
      setData(result);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load dashboard.');
      setData(null);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => clearInterval(timer);
  }, [refresh]);

  const executeControl = async (task: () => Promise<unknown>) => {
    if (controlBusy) return;
    setControlBusy(true);
    try {
      await task();
      await refresh();
      Alert.alert('Command sent', 'The server accepted the command.');
    } catch (err) {
      Alert.alert('Command failed', err instanceof Error ? err.message : 'Unable to execute command.');
    } finally {
      setControlBusy(false);
    }
  };

  const confirmControl = (title: string, message: string, task: () => Promise<unknown>) => {
    Alert.alert(title, message, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Confirm', style: 'destructive', onPress: () => { void executeControl(task); } },
    ]);
  };

  const handleSignOut = () => {
    Alert.alert('Sign out', 'Sign out of Tree Bot on this device?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Sign out', style: 'destructive', onPress: () => {
        void signOut().catch((err) => Alert.alert('Sign out failed', err.message));
      } },
    ]);
  };

  const connected = data !== null;
  const heartbeat = data?.heartbeat
    ? new Date(data.heartbeat * 1000).toLocaleTimeString()
    : 'No heartbeat recorded';

  const profitFactor =
    data?.stats.profit_factor === 'Infinity' ||
    data?.stats.profit_factor === 'inf'
      ? '∞'
      : data?.stats.profit_factor !== undefined
        ? money(Number(data.stats.profit_factor))
        : '—';

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView
        contentContainerStyle={styles.container}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              refresh();
            }}
            tintColor={C.green}
          />
        }
      >
        <View style={styles.header}>
          <View>
            <Text style={styles.brand}>TREE BOT</Text>
            <Text style={styles.subtitle}>Trading intelligence</Text>
          </View>
          <View style={styles.status}>
            <View style={[styles.dot, {
              backgroundColor: connected ? C.green : C.red,
            }]} />
            <Text style={[styles.statusText, {
              color: connected ? C.green : C.red,
            }]}>
              {connected ? 'CONNECTED' : 'DISCONNECTED'}
            </Text>
          </View>
        </View>

        <View style={styles.accountRow}>
          <Text style={styles.accountEmail}>{user?.email ?? 'Signed in'}</Text>
          <Pressable onPress={handleSignOut} style={styles.settings}>
            <Text style={styles.dangerText}>SIGN OUT</Text>
          </Pressable>
        </View>

        <View style={styles.headingRow}>
          <View>
            <Text style={styles.heading}>Command centre</Text>
            <Text style={styles.muted}>Live engine monitoring</Text>
          </View>
          <View style={styles.actionButtons}>
            <Pressable
              style={styles.settings}
              onPress={() => router.push('/settings')}
            >
              <Text style={styles.settingsText}>TRADING SETTINGS</Text>
            </Pressable>
            <Pressable
              style={styles.settings}
              onPress={() => router.push('/connect')}
            >
              <Text style={styles.settingsText}>CONNECTION</Text>
            </Pressable>
          </View>
        </View>

        {loading && !data ? (
          <View style={styles.message}>
            <ActivityIndicator color={C.green} />
            <Text style={styles.muted}>Connecting to your trading engine...</Text>
          </View>
        ) : null}

        {error ? (
          <View style={styles.errorBox}>
            <Text style={styles.errorTitle}>Dashboard unavailable</Text>
            <Text style={styles.errorText}>{error}</Text>
            <Pressable style={styles.retry} onPress={refresh}>
              <Text style={styles.retryText}>TRY AGAIN</Text>
            </Pressable>
          </View>
        ) : null}

        <Section title="ACCOUNT OVERVIEW">
          <View style={styles.metricsGrid}>
            <Metric label="EQUITY" value={data ? money(data.account.equity) : '—'} />
            <Metric
              label="DAILY P&L"
              value={data ? money(data.account.day_pnl) : '—'}
              color={(data?.account.day_pnl ?? 0) >= 0 ? C.green : C.red}
            />
            <Metric
              label="DRAWDOWN"
              value={data ? `${money(data.account.drawdown_pct)}%` : '—'}
              color={C.amber}
            />
            <Metric label="OPENED TODAY" value={data ? String(data.today.opened) : '—'} />
          </View>
        </Section>

        <Section title="TRADING PERFORMANCE">
          <View style={styles.metricsGrid}>
            <Metric label="CLOSED TRADES" value={data ? String(data.stats.trades) : '—'} />
            <Metric
              label="WIN RATE"
              value={data ? `${money(data.stats.win_rate * 100)}%` : '—'}
            />
            <Metric
              label="NET P&L"
              value={data ? money(data.stats.net_pnl) : '—'}
              color={(data?.stats.net_pnl ?? 0) >= 0 ? C.green : C.red}
            />
            <Metric label="PROFIT FACTOR" value={profitFactor} />
            <Metric label="EXPECTANCY" value={data ? money(data.stats.expectancy) : '—'} />
            <Metric label="MAX DRAWDOWN" value={data ? money(data.stats.max_drawdown) : '—'} />
          </View>
        </Section>

        <Section title="ENGINE & RISK STATUS">
          <View style={styles.infoRow}>
            <Text style={styles.infoLabel}>Operating mode</Text>
            <Text style={styles.infoValue}>{data?.run_mode ?? '—'}</Text>
          </View>
          <View style={styles.infoRow}>
            <Text style={styles.infoLabel}>Kill switch</Text>
            <Text style={[styles.infoValue, {
              color: data?.kill.mode === 'active' ? C.red : C.green,
            }]}>
              {data?.kill.mode ?? '—'}
            </Text>
          </View>
          <View style={styles.infoRow}>
            <Text style={styles.infoLabel}>Kill reason</Text>
            <Text style={styles.infoValue}>{data?.kill.reason || '—'}</Text>
          </View>
          <View style={styles.infoRow}>
            <Text style={styles.infoLabel}>Last heartbeat</Text>
            <Text style={styles.infoValue}>{heartbeat}</Text>
          </View>
        </Section>

        {access?.admin ? (
          <Section title="ADMIN CONTROL PANEL">
            <Text style={styles.muted}>Authorised administrator: {user?.email ?? 'Signed in'}</Text>
            <View style={styles.controlGrid}>
              <Pressable disabled={controlBusy} style={styles.controlButton} onPress={() => confirmControl('Start engine?', 'Start the trading engine?', () => controlEngine('start'))}>
                <Text style={styles.settingsText}>START ENGINE</Text>
              </Pressable>
              <Pressable disabled={controlBusy} style={styles.controlButton} onPress={() => confirmControl('Stop engine?', 'Stop new trading activity? Existing positions may remain open.', () => controlEngine('stop'))}>
                <Text style={styles.dangerText}>STOP ENGINE</Text>
              </Pressable>
              <Pressable disabled={controlBusy} style={styles.controlButton} onPress={() => confirmControl('Pause trading?', 'Activate the pause kill switch?', () => controlKillSwitch('pause'))}>
                <Text style={styles.settingsText}>PAUSE TRADING</Text>
              </Pressable>
              <Pressable disabled={controlBusy} style={styles.controlButton} onPress={() => confirmControl('Freeze trading?', 'Freeze trading activity?', () => controlKillSwitch('freeze'))}>
                <Text style={styles.dangerText}>FREEZE TRADING</Text>
              </Pressable>
              <Pressable disabled={controlBusy} style={[styles.controlButton, styles.dangerButton]} onPress={() => confirmControl('EMERGENCY LIQUIDATION', 'This may close open positions at market prices. Confirm only if you intend to liquidate.', () => controlKillSwitch('liquidate'))}>
                <Text style={styles.dangerText}>EMERGENCY LIQUIDATE</Text>
              </Pressable>
              <Pressable disabled={controlBusy} style={styles.controlButton} onPress={() => confirmControl('Reset kill switch?', 'Only reset after verifying the risk condition is resolved. Type confirmation is enforced by the server.', () => controlKillSwitch('reset'))}>
                <Text style={styles.settingsText}>RESET KILL SWITCH</Text>
              </Pressable>
            </View>
            {controlBusy ? <ActivityIndicator color={C.green} /> : null}
            <Pressable onPress={handleSignOut} style={styles.signOutButton}>
              <Text style={styles.dangerText}>SIGN OUT</Text>
            </Pressable>
          </Section>
        ) : null}

        <Section title="RECENT TRADE ACTIVITY">
          {data?.nodes?.length ? (
            data.nodes.slice(-6).reverse().map((node) => (
              <View key={node.node_id} style={styles.tradeRow}>
                <View style={styles.tradeMain}>
                  <Text style={styles.tradeSymbol}>
                    {node.symbol || 'Unknown symbol'} · {node.side || '—'}
                  </Text>
                  <Text style={styles.tradeDetail}>
                    {node.state} · Level {node.level} · Volume {node.volume}
                  </Text>
                  <Text style={styles.tradeDetail}>
                    Entry {money(node.entry)} · SL {money(node.sl)} · TP {money(node.tp)}
                  </Text>
                </View>
                <Text style={[styles.tradePnl, {
                  color: node.net_pnl >= 0 ? C.green : C.red,
                }]}>
                  {money(node.net_pnl)}
                </Text>
              </View>
            ))
          ) : (
            <Text style={styles.muted}>No trade activity available.</Text>
          )}
        </Section>

        <Section title="TODAY'S RESULTS">
          <View style={styles.metricsGrid}>
            <Metric label="WINS" value={data ? String(data.today.wins) : '—'} color={C.green} />
            <Metric label="LOSSES" value={data ? String(data.today.losses) : '—'} color={C.red} />
            <Metric label="WIN %" value={data ? `${money(data.today.win_pct)}%` : '—'} />
            <Metric label="TODAY'S NET" value={data ? money(data.today.net) : '—'} />
          </View>
        </Section>

        <Section title="REJECTION MONITOR">
          {data?.rejections?.length ? (
            data.rejections.slice(0, 5).map(([reason, count], index) => (
              <View key={`${reason}-${index}`} style={styles.infoRow}>
                <Text style={styles.infoLabel}>{reason}</Text>
                <Text style={styles.infoValue}>{count}</Text>
              </View>
            ))
          ) : (
            <Text style={styles.muted}>No rejection records available.</Text>
          )}
        </Section>

        <Pressable style={styles.refreshButton} onPress={refresh}>
          <Text style={styles.refreshText}>REFRESH DASHBOARD</Text>
        </Pressable>

        <Text style={styles.footer}>TREE BOT · SECURE TRADING CONSOLE</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg },
  container: { padding: 20, paddingBottom: 35 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  brand: { color: C.green, fontSize: 14, fontWeight: '900', letterSpacing: 2 },
  subtitle: { color: C.muted, fontSize: 11, marginTop: 4 },
  status: { flexDirection: 'row', alignItems: 'center', backgroundColor: C.card, padding: 9, borderRadius: 20 },
  dot: { width: 7, height: 7, borderRadius: 5, marginRight: 7 },
  statusText: { fontSize: 9, fontWeight: '900' },
  headingRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 30, marginBottom: 22 },
  heading: { color: C.text, fontSize: 25, fontWeight: '900' },
  muted: { color: C.muted, fontSize: 11, lineHeight: 18 },
  actionButtons: { flexDirection: 'row', gap: 7 },
  settings: { borderWidth: 1, borderColor: C.border, padding: 10, borderRadius: 8 },
  settingsText: { color: C.green, fontSize: 9, fontWeight: '900' },
  section: { marginBottom: 17 },
  sectionTitle: { color: C.muted, fontSize: 10, fontWeight: '900', letterSpacing: 1.2, marginBottom: 9 },
  card: { backgroundColor: C.card, borderWidth: 1, borderColor: C.border, borderRadius: 14, padding: 15 },
  metricsGrid: { flexDirection: 'row', flexWrap: 'wrap' },
  metric: { width: '50%', paddingVertical: 10, paddingRight: 8 },
  metricLabel: { color: C.muted, fontSize: 9, fontWeight: '700', marginBottom: 7 },
  metricValue: { fontSize: 19, fontWeight: '800' },
  infoRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: C.border },
  infoLabel: { color: C.muted, fontSize: 11, flex: 1 },
  infoValue: { color: C.text, fontSize: 11, fontWeight: '700', flex: 1, textAlign: 'right' },
  tradeRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 11, borderBottomWidth: 1, borderBottomColor: C.border },
  tradeMain: { flex: 1, paddingRight: 8 },
  tradeSymbol: { color: C.text, fontSize: 12, fontWeight: '800' },
  tradeDetail: { color: C.muted, fontSize: 9, marginTop: 5 },
  tradePnl: { fontSize: 12, fontWeight: '800' },
  message: { alignItems: 'center', gap: 12, padding: 25 },
  errorBox: { backgroundColor: '#302326', borderRadius: 12, padding: 15, marginBottom: 17 },
  errorTitle: { color: C.red, fontWeight: '800', marginBottom: 6 },
  errorText: { color: C.text, fontSize: 11, lineHeight: 18 },
  retry: { marginTop: 12, alignSelf: 'flex-start', padding: 9, backgroundColor: C.card, borderRadius: 7 },
  retryText: { color: C.green, fontSize: 10, fontWeight: '900' },
  refreshButton: { backgroundColor: C.green, borderRadius: 10, padding: 15, alignItems: 'center', marginTop: 5 },
  refreshText: { color: C.bg, fontSize: 10, fontWeight: '900', letterSpacing: 1 },
  accountRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 14 },
  accountEmail: { color: C.muted, fontSize: 10, flex: 1, marginRight: 10 },
  controlGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 9, marginTop: 14 },
  controlButton: { width: '48%', minHeight: 44, justifyContent: 'center', alignItems: 'center', padding: 10, borderWidth: 1, borderColor: C.border, borderRadius: 8 },
  dangerButton: { borderColor: C.red, width: '100%' },
  dangerText: { color: C.red, fontSize: 9, fontWeight: '900' },
  signOutButton: { marginTop: 16, padding: 12, alignItems: 'center', borderWidth: 1, borderColor: C.red, borderRadius: 8 },
  footer: { color: '#62727A', fontSize: 9, textAlign: 'center', marginTop: 22, letterSpacing: 1 },
});
