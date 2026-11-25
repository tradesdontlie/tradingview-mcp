import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { router } from 'expo-router';
import {
  loadConnection,
  saveConnection,
  testConnection,
} from '../services/connection';

export default function ConnectScreen() {
  const [serverUrl, setServerUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    let active = true;

    loadConnection().then((saved) => {
      if (active && saved) {
        setServerUrl(saved.serverUrl);
      }
    }).catch(() => {
      if (active) {
        setMessage('Could not load saved connection settings.');
      }
    });

    return () => {
      active = false;
    };
  }, []);

  async function handleConnect() {
    if (!serverUrl.trim()) {
      Alert.alert('Missing details', 'Enter your server URL.');
      return;
    }

    setLoading(true);
    setMessage('');

    try {
      const config = {
        serverUrl: serverUrl.trim(),
      };

      await testConnection(config);
      await saveConnection(config);

      setMessage('Connection successful. Settings securely saved.');
      Alert.alert('Connected', 'Your Tree Bot backend responded successfully.', [
        {
          text: 'Continue',
          onPress: () => router.replace('/'),
        },
      ]);
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : 'Connection failed.',
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={styles.container}>
        <Pressable onPress={() => router.back()}>
          <Text style={styles.back}>‹  BACK</Text>
        </Pressable>

        <Text style={styles.brand}>TREE BOT</Text>
        <Text style={styles.title}>Connect your engine.</Text>
        <Text style={styles.description}>
          Enter your Python trading server address. Your signed-in Tree Bot account authenticates automatically.
        </Text>

        <View style={styles.card}>
          <Text style={styles.label}>SERVER ADDRESS</Text>
          <TextInput
            value={serverUrl}
            onChangeText={setServerUrl}
            placeholder="https://your-private-server"
            placeholderTextColor="#71818A"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            style={styles.input}
          />

          <Pressable
            onPress={handleConnect}
            disabled={loading}
            style={({ pressed }) => [
              styles.button,
              pressed && styles.buttonPressed,
              loading && styles.buttonDisabled,
            ]}
          >
            {loading ? (
              <ActivityIndicator color="#10181D" />
            ) : (
              <Text style={styles.buttonText}>TEST AND SAVE CONNECTION</Text>
            )}
          </Pressable>

          {message ? <Text style={styles.message}>{message}</Text> : null}
        </View>

        <View style={styles.warning}>
          <Text style={styles.warningTitle}>NETWORK SECURITY</Text>
          <Text style={styles.warningText}>
            Do not expose port 8765 directly to the public internet. Prefer
            HTTPS through a private network such as Tailscale Serve.
          </Text>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: '#10181D',
  },
  container: {
    flexGrow: 1,
    padding: 22,
    paddingTop: 35,
  },
  back: {
    color: '#91A1A9',
    fontSize: 13,
    fontWeight: '700',
    marginBottom: 45,
  },
  brand: {
    color: '#4CC39A',
    fontSize: 13,
    fontWeight: '800',
    letterSpacing: 2,
  },
  title: {
    color: '#F3F7F8',
    fontSize: 30,
    fontWeight: '800',
    marginTop: 14,
  },
  description: {
    color: '#91A1A9',
    fontSize: 13,
    lineHeight: 21,
    marginTop: 10,
    marginBottom: 28,
  },
  card: {
    backgroundColor: '#19242B',
    borderColor: '#293840',
    borderWidth: 1,
    borderRadius: 18,
    padding: 18,
  },
  label: {
    color: '#91A1A9',
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1,
    marginBottom: 9,
    marginTop: 8,
  },
  input: {
    backgroundColor: '#10181D',
    borderColor: '#34444C',
    borderWidth: 1,
    borderRadius: 10,
    color: '#F3F7F8',
    paddingHorizontal: 13,
    paddingVertical: 14,
    fontSize: 13,
    marginBottom: 17,
  },
  button: {
    backgroundColor: '#4CC39A',
    borderRadius: 10,
    padding: 16,
    alignItems: 'center',
    marginTop: 8,
  },
  buttonPressed: {
    opacity: 0.8,
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  buttonText: {
    color: '#10181D',
    fontSize: 11,
    fontWeight: '900',
    letterSpacing: 0.5,
  },
  message: {
    color: '#B4C8C1',
    fontSize: 12,
    lineHeight: 19,
    marginTop: 15,
  },
  warning: {
    backgroundColor: '#302B22',
    borderRadius: 12,
    padding: 15,
    marginTop: 18,
  },
  warningTitle: {
    color: '#E8C27A',
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1,
    marginBottom: 7,
  },
  warningText: {
    color: '#D2C4A8',
    fontSize: 11,
    lineHeight: 18,
  },
});
