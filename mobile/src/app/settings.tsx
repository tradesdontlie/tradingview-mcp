import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { router } from 'expo-router';
import {
  fetchSettings,
  saveSettings,
  fetchEngineStatus,
  TradingSettings,
  EngineStatus,
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

type Profile = TradingSettings['profile'];

export default function SettingsScreen() {
  const [settings, setSettings] = useState<TradingSettings | null>(null);
  const [engine, setEngine] = useState<EngineStatus | null>(null);
  const [allocation, setAllocation] = useState('');
  const [riskAmount, setRiskAmount] = useState('');
  const [dailyLoss, setDailyLoss] = useState('');
  const [maxOpen, setMaxOpen] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setError('');
      const [data, status] = await Promise.all([
        fetchSettings(),
        fetchEngineStatus(),
      ]);

      setSettings(data);
      setEngine(status);
      setAllocation(String(data.allocated_capital));
      setRiskAmount(String(data.risk_per_trade_amount));
      setDailyLoss(String(Number((data.daily_loss_pct * 100).toFixed(3))));
      setMaxOpen(String(data.max_open));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load settings.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const chooseProfile = (profile: Profile) => {
    if (settings) setSettings({ ...settings, profile });
  };

  const handleSave = async () => {
    if (!settings) return;

    const values = [
      Number(allocation),
      Number(riskAmount),
      Number(dailyLoss),
      Number(maxOpen),
    ];

    if (values.some((value) => !Number.isFinite(value))) {
      Alert.alert('Invalid values', 'Enter valid numbers in all fields.');
      return;
    }

    if (values[0] < 0 || values[1] < 0) {
      Alert.alert('Invalid values', 'Capital and risk amounts cannot be negative.');
      return;
    }

    if (values[2] < 0.1 || values[2] > 20) {
      Alert.alert('Invalid daily loss limit', 'Enter a percentage between 0.1 and 20.');
      return;
    }

    if (!Number.isInteger(values[3]) || values[3] < 1 || values[3] > 5) {
      Alert.alert('Invalid maximum trades', 'Choose a whole number between 1 and 5.');
      return;
    }

    try {
      setSaving(true);
      const updated: TradingSettings = {
        ...settings,
        allocated_capital: values[0],
        risk_per_trade_amount: values[1],
        daily_loss_pct: values[2] / 100,
        max_open: values[3],
      };

      const result = await saveSettings(updated);
      setSettings(result.settings);
      Alert.alert('Saved', 'Trading settings have been saved.');
      await load();
    } catch (e) {
      Alert.alert(
        'Save failed',
        e instanceof Error ? e.message : 'Could not save settings.',
      );
    } finally {
      setSaving(false);
    }
  };

  const Field = ({
    label,
    value,
    onChangeText,
    hint,
  }: {
    label: string;
    value: string;
    onChangeText: (value: string) => void;
    hint: string;
  }) => (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        style={styles.input}
        value={value}
        onChangeText={onChangeText}
        keyboardType="decimal-pad"
        placeholder="0"
        placeholderTextColor={C.muted}
      />
      <Text style={styles.hint}>{hint}</Text>
    </View>
  );

  if (loading) {
    return (
      <SafeAreaView style={styles.center}>
        <ActivityIndicator color={C.green} size="large" />
        <Text style={styles.muted}>Loading trading settings...</Text>
      </SafeAreaView>
    );
  }

  if (!settings) {
    return (
      <SafeAreaView style={styles.center}>
        <Text style={styles.heading}>Trading Settings</Text>
        <Text style={styles.error}>{error || 'Settings unavailable.'}</Text>
        <Pressable style={styles.primaryButton} onPress={() => router.push('/connect')}>
          <Text style={styles.buttonText}>CONNECT SERVER</Text>
        </Pressable>
        <Pressable style={styles.secondaryButton} onPress={load}>
          <Text style={styles.buttonText}>RETRY</Text>
        </Pressable>
        <Pressable onPress={() => router.back()}>
          <Text style={styles.muted}>Go back</Text>
        </Pressable>
      </SafeAreaView>
    );
  }

  const stopped = engine?.state === 'STOPPED';

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.topRow}>
          <View>
            <Text style={styles.heading}>Trading Settings</Text>
            <Text style={styles.subtitle}>Configure your bot controls</Text>
          </View>
          <Pressable onPress={() => router.back()} style={styles.backButton}>
            <Text style={styles.backText}>BACK</Text>
          </Pressable>
        </View>

        <View style={styles.statusCard}>
          <Text style={styles.label}>ENGINE STATUS</Text>
          <Text style={[
            styles.status,
            { color: stopped ? C.green : engine?.state === 'ERROR' ? C.red : C.amber },
          ]}>
            {engine?.state || 'UNKNOWN'}
          </Text>
          <Text style={styles.hint}>
            Settings can only be saved while the engine is stopped.
          </Text>
          {engine?.error ? <Text style={styles.error}>{engine.error}</Text> : null}
        </View>

        <Text style={styles.sectionTitle}>TRADING PROFILE</Text>
        <View style={styles.profileRow}>
          {(['standard', 'small', 'scalp'] as Profile[]).map((profile) => (
            <Pressable
              key={profile}
              onPress={() => chooseProfile(profile)}
              style={[
                styles.profileButton,
                settings.profile === profile && styles.profileSelected,
              ]}
            >
              <Text style={[
                styles.profileText,
                settings.profile === profile && styles.profileTextSelected,
              ]}>
                {profile.toUpperCase()}
              </Text>
            </Pressable>
          ))}
        </View>

        <Text style={styles.sectionTitle}>CAPITAL AND RISK</Text>
        <View style={styles.card}>
          <Field
            label="Allocated capital"
            value={allocation}
            onChangeText={setAllocation}
            hint="0 = use available account equity. Otherwise, sets an allocation cap."
          />
          <Field
            label="Fixed risk per trade"
            value={riskAmount}
            onChangeText={setRiskAmount}
            hint="Account currency. 0 = use the selected profile's percentage risk."
          />
          <Field
            label="Daily loss limit (%)"
            value={dailyLoss}
            onChangeText={setDailyLoss}
            hint="Allowed range: 0.1% to 20%."
          />
          <Field
            label="Maximum open trades"
            value={maxOpen}
            onChangeText={setMaxOpen}
            hint="Allowed range: 1 to 5."
          />
        </View>

        <View style={styles.warning}>
          <Text style={styles.warningTitle}>RISK WARNING</Text>
          <Text style={styles.warningText}>
            These controls do not guarantee a maximum loss. Slippage, market
            gaps, execution delays, and broker issues can cause losses beyond
            the configured limits. Validate using a demo account first.
          </Text>
        </View>

        {error ? <Text style={styles.error}>{error}</Text> : null}

        <Pressable
          style={[
            styles.primaryButton,
            (!stopped || saving) && styles.disabledButton,
          ]}
          onPress={handleSave}
          disabled={!stopped || saving}
        >
          {saving
            ? <ActivityIndicator color={C.bg} />
            : <Text style={styles.saveText}>SAVE SETTINGS</Text>}
        </Pressable>

        {!stopped ? (
          <Text style={styles.hint}>
            Stop the trading engine before changing settings.
          </Text>
        ) : null}

        <Pressable style={styles.secondaryButton} onPress={load}>
          <Text style={styles.buttonText}>REFRESH SETTINGS</Text>
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  center: {
    flex: 1,
    backgroundColor: C.bg,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
    gap: 16,
  },
  content: { padding: 20, paddingBottom: 40 },
  topRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 22,
  },
  heading: { color: C.text, fontSize: 25, fontWeight: '800' },
  subtitle: { color: C.muted, marginTop: 5 },
  backButton: {
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 8,
    paddingHorizontal: 13,
    paddingVertical: 9,
  },
  backText: { color: C.text, fontWeight: '700', fontSize: 12 },
  statusCard: {
    backgroundColor: C.card,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 12,
    padding: 16,
    marginBottom: 24,
  },
  status: { fontSize: 20, fontWeight: '800', marginTop: 7 },
  sectionTitle: {
    color: C.muted,
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 1.2,
    marginBottom: 12,
  },
  profileRow: { flexDirection: 'row', gap: 8, marginBottom: 24 },
  profileButton: {
    flex: 1,
    paddingVertical: 13,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 9,
    alignItems: 'center',
    backgroundColor: C.card,
  },
  profileSelected: {
    borderColor: C.green,
    backgroundColor: '#203A35',
  },
  profileText: { color: C.muted, fontWeight: '700', fontSize: 12 },
  profileTextSelected: { color: C.green },
  card: {
    backgroundColor: C.card,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 12,
    padding: 16,
    marginBottom: 20,
  },
  field: { marginBottom: 19 },
  label: { color: C.text, fontWeight: '700', fontSize: 14, marginBottom: 8 },
  input: {
    backgroundColor: C.bg,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 8,
    color: C.text,
    paddingHorizontal: 13,
    paddingVertical: 12,
    fontSize: 16,
  },
  hint: { color: C.muted, fontSize: 11, marginTop: 6, lineHeight: 16 },
  muted: { color: C.muted, fontSize: 13, textAlign: 'center' },
  warning: {
    backgroundColor: '#30291D',
    borderColor: '#66502D',
    borderWidth: 1,
    borderRadius: 10,
    padding: 14,
    marginBottom: 20,
  },
  warningTitle: { color: C.amber, fontWeight: '800', marginBottom: 6 },
  warningText: { color: C.text, fontSize: 12, lineHeight: 18 },
  error: { color: C.red, textAlign: 'center', marginVertical: 10 },
  primaryButton: {
    backgroundColor: C.green,
    borderRadius: 9,
    padding: 16,
    alignItems: 'center',
    marginBottom: 12,
  },
  disabledButton: { opacity: 0.4 },
  saveText: { color: C.bg, fontWeight: '900', letterSpacing: 0.7 },
  buttonText: { color: C.text, fontWeight: '800' },
  secondaryButton: {
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 9,
    padding: 14,
    alignItems: 'center',
    marginBottom: 12,
  },
});
