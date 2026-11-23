import React, { useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Link } from 'expo-router';
import { supabase } from '../services/supabase';

export default function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);

  async function sendReset() {
    if (!email.trim()) {
      Alert.alert('Email required', 'Enter your account email.');
      return;
    }

    setBusy(true);
    const { error } = await supabase.auth.resetPasswordForEmail(
      email.trim(),
      { redirectTo: 'treebot://auth/callback' }
    );
    setBusy(false);

    if (error) Alert.alert('Unable to send email', error.message);
    else Alert.alert('Check your email', 'If the account exists, a password reset link has been sent.');
  }

  return (
    <View style={styles.container}>
      <Text style={styles.logo}>TREEBOT</Text>
      <Text style={styles.title}>Reset password</Text>
      <Text style={styles.subtitle}>Enter your registered email to receive a reset link.</Text>
      <TextInput
        style={styles.input}
        placeholder="Email address"
        placeholderTextColor="#849198"
        keyboardType="email-address"
        autoCapitalize="none"
        value={email}
        onChangeText={setEmail}
      />
      <Pressable style={styles.button} onPress={sendReset} disabled={busy}>
        <Text style={styles.buttonText}>{busy ? 'Sending...' : 'Send reset link'}</Text>
      </Pressable>
      <Link href="/login" style={styles.link}>Back to login</Link>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#10181D', justifyContent: 'center', padding: 26 },
  logo: { color: '#35D07F', fontSize: 15, fontWeight: '800', letterSpacing: 3, marginBottom: 24 },
  title: { color: '#FFFFFF', fontSize: 29, fontWeight: '800', marginBottom: 10 },
  subtitle: { color: '#AAB6BC', fontSize: 14, marginBottom: 25, lineHeight: 21 },
  input: { backgroundColor: '#1B292F', color: '#FFFFFF', borderRadius: 10, padding: 16, marginBottom: 16 },
  button: { backgroundColor: '#35D07F', padding: 16, borderRadius: 10, alignItems: 'center' },
  buttonText: { color: '#10181D', fontWeight: '800' },
  link: { color: '#35D07F', textAlign: 'center', marginTop: 24 },
});
