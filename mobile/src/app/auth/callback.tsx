import React, { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { supabase } from '../../services/supabase';

export default function AuthCallback() {
  const params = useLocalSearchParams<{
    code?: string;
    token_hash?: string;
    type?: string;
    error_description?: string;
  }>();

  const [message, setMessage] = useState('Verifying your email...');

  useEffect(() => {
    let active = true;

    async function completeAuth() {
      try {
        if (params.error_description) {
          throw new Error(params.error_description);
        }

        if (params.code) {
          const { error } = await supabase.auth.exchangeCodeForSession(
            params.code
          );
          if (error) throw error;
        } else if (params.token_hash && params.type) {
          const { error } = await supabase.auth.verifyOtp({
            token_hash: params.token_hash,
            type: params.type as 'signup' | 'recovery' | 'email',
          });
          if (error) throw error;
        } else {
          throw new Error('The email link is invalid or expired.');
        }

        if (active) {
          setMessage('Verification successful. Opening TreeBot...');
          setTimeout(() => router.replace('/'), 700);
        }
      } catch (error) {
        if (active) {
          setMessage(
            error instanceof Error ? error.message : 'Verification failed.'
          );
        }
      }
    }

    completeAuth();

    return () => {
      active = false;
    };
  }, [params.code, params.token_hash, params.type, params.error_description]);

  return (
    <View style={styles.container}>
      <ActivityIndicator color="#35D07F" size="large" />
      <Text style={styles.message}>{message}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#10181D',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 28,
  },
  message: {
    color: '#FFFFFF',
    marginTop: 20,
    textAlign: 'center',
    fontSize: 15,
  },
});
