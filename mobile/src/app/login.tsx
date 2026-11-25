import React, { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Link, router } from 'expo-router';
import { useAuth } from '../services/auth';

export default function LoginScreen() {
  const { signIn } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  async function handleLogin() {
    if (!email.trim() || !password) {
      Alert.alert('Missing details', 'Enter your email and password.');
      return;
    }
    setBusy(true);
    try {
      await signIn(email, password);
      router.replace('/');
    } catch (error) {
      Alert.alert('Login failed', error instanceof Error ? error.message : 'Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView
      style={styles.page}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={styles.content}>
        <Text style={styles.brand}>TREE<Text style={styles.accent}>BOT</Text></Text>
        <Text style={styles.heading}>Welcome back</Text>
        <Text style={styles.sub}>Sign in to access your trading dashboard.</Text>

        <Text style={styles.label}>EMAIL ADDRESS</Text>
        <TextInput
          style={styles.input}
          value={email}
          onChangeText={setEmail}
          placeholder="you@example.com"
          placeholderTextColor="#718087"
          keyboardType="email-address"
          autoCapitalize="none"
          autoCorrect={false}
        />

        <Text style={styles.label}>PASSWORD</Text>
        <TextInput
          style={styles.input}
          value={password}
          onChangeText={setPassword}
          placeholder="Enter your password"
          placeholderTextColor="#718087"
          secureTextEntry
          autoCapitalize="none"
        />

        <Pressable style={styles.button} onPress={handleLogin} disabled={busy}>
          {busy ? <ActivityIndicator color="#10181D" /> : <Text style={styles.buttonText}>SIGN IN</Text>}
        </Pressable>

        <Link href="/forgot-password" style={styles.link}>Forgot your password?</Link>
        <View style={styles.footer}>
          <Text style={styles.sub}>New to Tree Bot? </Text>
          <Link href="/register" style={styles.link}>Create account</Link>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: '#10181D', justifyContent: 'center', padding: 24 },
  content: { width: '100%', maxWidth: 440, alignSelf: 'center' },
  brand: { color: '#FFFFFF', fontSize: 30, fontWeight: '900', letterSpacing: 3, marginBottom: 42 },
  accent: { color: '#4CC39A' },
  heading: { color: '#FFFFFF', fontSize: 27, fontWeight: '800', marginBottom: 8 },
  sub: { color: '#9BA9AE', fontSize: 14, lineHeight: 21 },
  label: { color: '#9BA9AE', fontSize: 11, fontWeight: '800', letterSpacing: 1.2, marginTop: 25, marginBottom: 9 },
  input: { backgroundColor: '#1B292F', color: '#FFFFFF', borderWidth: 1, borderColor: '#304149', borderRadius: 12, padding: 16, fontSize: 15 },
  button: { backgroundColor: '#4CC39A', borderRadius: 12, padding: 17, alignItems: 'center', marginTop: 30 },
  buttonText: { color: '#10181D', fontWeight: '900', letterSpacing: 1 },
  link: { color: '#4CC39A', fontWeight: '700', marginTop: 20, textAlign: 'center' },
  footer: { flexDirection: 'row', justifyContent: 'center', marginTop: 35 },
});
