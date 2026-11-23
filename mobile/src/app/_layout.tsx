import { useEffect } from 'react';
import { Stack, useRouter, useSegments, useRootNavigationState } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { AuthProvider, useAuth } from '../services/auth';

function RootNavigator() {
  const { session, loading } = useAuth();
  const router = useRouter();
  const segments = useSegments();
  const navigationState = useRootNavigationState();

  useEffect(() => {
    if (loading || !navigationState?.key) return;

    const first = segments[0] as string | undefined;
    const publicRoute =
      first === 'login' ||
      first === 'register' ||
      first === 'forgot-password' ||
      first === 'auth';

    if (!session && !publicRoute) {
      router.replace('/login');
    } else if (session && (
      first === 'login' ||
      first === 'register' ||
      first === 'forgot-password'
    )) {
      router.replace('/');
    }
  }, [session, loading, segments, navigationState?.key]);

  return (
    <>
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: '#10181D' },
        }}
      />
    </>
  );
}

export default function RootLayout() {
  return (
    <AuthProvider>
      <RootNavigator />
    </AuthProvider>
  );
}
