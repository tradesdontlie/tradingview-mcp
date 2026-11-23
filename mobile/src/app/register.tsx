import React, { useState } from 'react';
import {
  ActivityIndicator, Alert, KeyboardAvoidingView, Platform,
  Pressable, StyleSheet, Text, TextInput, View,
} from 'react-native';
import { Link, router } from 'expo-router';
import { useAuth } from '../services/auth';

export default function RegisterScreen() {
  const { signUp } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);

  async function handleRegister() {
    if (!email.trim() || !password) {
      Alert.alert('Missing details', 'Enter your email and password.');
      return;
    }
    if (password.length < 8) {
      Alert.alert('Password too short', 'Use at least 8 characters.');
      return;
    }
    if (password !== confirm) {
      Alert.alert('Passwords do not match', 'Check your confirmation.');
      return;
    }
    setBusy(true);
    try {
      const hasSession = await signUp(email, password);
      if (hasSession) router.replace('/');
      else Alert.alert('Check your email', 'We sent a confirmation link. Open it to activate your account, then sign in.');
    } catch (error) {
      Alert.alert('Registration failed', error instanceof Error ? error.message : 'Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView style={s.page} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={s.content}>
        <Text style={s.brand}>TREE<Text style={s.accent}>BOT</Text></Text>
        <Text style={s.heading}>Create your account</Text>
        <Text style={s.sub}>Register to securely access your trading dashboard.</Text>
        <Text style={s.label}>EMAIL ADDRESS</Text>
        <TextInput style={s.input} value={email} onChangeText={setEmail} placeholder="you@example.com" placeholderTextColor="#718087" keyboardType="email-address" autoCapitalize="none" autoCorrect={false} />
        <Text style={s.label}>PASSWORD</Text>
        <TextInput style={s.input} value={password} onChangeText={setPassword} placeholder="At least 8 characters" placeholderTextColor="#718087" secureTextEntry />
        <Text style={s.label}>CONFIRM PASSWORD</Text>
        <TextInput style={s.input} value={confirm} onChangeText={setConfirm} placeholder="Enter password again" placeholderTextColor="#718087" secureTextEntry />
        <Pressable style={s.button} onPress={handleRegister} disabled={busy}>
          {busy ? <ActivityIndicator color="#10181D" /> : <Text style={s.buttonText}>CREATE ACCOUNT</Text>}
        </Pressable>
        <View style={s.footer}><Text style={s.sub}>Already registered? </Text><Link href="/login" style={s.link}>Sign in</Link></View>
      </View>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  page: { flex: 1, backgroundColor: '#10181D', justifyContent: 'center', padding: 24 },
  content: { width: '100%', maxWidth: 440, alignSelf: 'center' },
  brand: { color: '#FFF', fontSize: 30, fontWeight: '900', letterSpacing: 3, marginBottom: 30 },
  accent: { color: '#4CC39A' },
  heading: { color: '#FFF', fontSize: 27, fontWeight: '800', marginBottom: 8 },
  sub: { color: '#9BA9AE', fontSize: 14 },
  label: { color: '#9BA9AE', fontSize: 11, fontWeight: '800', marginTop: 20, marginBottom: 8 },
  input: { backgroundColor: '#1B292F', color: '#FFF', borderWidth: 1, borderColor: '#304149', borderRadius: 12, padding: 15 },
  button: { backgroundColor: '#4CC39A', borderRadius: 12, padding: 17, alignItems: 'center', marginTop: 28 },
  buttonText: { color: '#10181D', fontWeight: '900' },
  footer: { flexDirection: 'row', justifyContent: 'center', marginTop: 28 },
  link: { color: '#4CC39A', fontWeight: '700' },
});
