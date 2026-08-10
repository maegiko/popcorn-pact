import { useRouter } from 'expo-router';
import { useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  Share,
  StyleSheet,
  TextInput,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AuthLoading } from '@/components/auth-loading';
import { GroupLoadError } from '@/components/group-required';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { InviteCodeLength, MaxContentWidth, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { useGroups, type JoinGroupResult } from '@/lib/group';

/** Codes are read aloud and typed by hand, so they are shown in two blocks. */
function formatCode(code: string) {
  return `${code.slice(0, 4)} ${code.slice(4)}`;
}

function expiryLabel(expiresAt: string) {
  const days = Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 86_400_000);
  if (days <= 0) return 'Expired';
  if (days === 1) return 'Expires tomorrow';
  return `Expires in ${days} days`;
}

/**
 * Copy for every non-success outcome of joining. `group_limit_reached` is
 * deliberately not phrased as an error: it is the free-tier ceiling, and the
 * place a paywall attaches in Phase 6.
 */
function joinMessage(result: JoinGroupResult): string | null {
  switch (result.status) {
    case 'joined':
    case 'already_member':
      return null;
    case 'invalid_code':
      return "That code doesn't exist. Check it and try again.";
    case 'expired':
      return 'That code has expired — ask for a new one.';
    case 'group_full':
      return 'That group is already full.';
    case 'group_limit_reached':
      return "You're already in a group. Leave it first to join another.";
    case 'error':
      return result.message;
  }
}

export default function PairScreen() {
  const { status, currentGroup } = useGroups();

  // Loading and error must not fall through to StartPairing: offering to create
  // a group to someone who already has one is exactly the mistake the distinct
  // error state exists to prevent.
  if (status === 'loading') return <AuthLoading />;
  if (status === 'error') return <GroupLoadError />;

  // Once a group exists the screen becomes about its invite, whichever way the
  // user arrived.
  if (!currentGroup) return <StartPairing />;
  return <GroupPanel />;
}

function StartPairing() {
  const theme = useTheme();
  const { createGroup, joinWithCode } = useGroups();

  const [mode, setMode] = useState<'choose' | 'join'>('choose');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const canJoin = code.length === InviteCodeLength && !busy;

  async function handleCreate() {
    setBusy(true);
    setMessage(null);

    const result = await createGroup();
    if (result.status === 'group_limit_reached') {
      setMessage("You're already in a group. Leave it first to start another.");
    } else if (result.status === 'error') {
      setMessage(result.message);
    }

    // On success the group arrives in context and this screen swaps itself for
    // the invite panel, so there is nothing to navigate to.
    setBusy(false);
  }

  async function handleJoin() {
    setBusy(true);
    setMessage(null);

    setMessage(joinMessage(await joinWithCode(code)));
    setBusy(false);
  }

  if (mode === 'join') {
    return (
      <Shell>
        <ThemedText type="subtitle">Enter their code</ThemedText>

        <ThemedText type="small" themeColor="textSecondary">
          Ask your partner for the {InviteCodeLength}-character code from their app.
        </ThemedText>

        <TextInput
          value={code}
          onChangeText={(next) =>
            setCode(next.replace(/[^0-9a-zA-Z]/g, '').toUpperCase().slice(0, InviteCodeLength))
          }
          placeholder="7GK2N4QX"
          placeholderTextColor={theme.textSecondary}
          autoCapitalize="characters"
          autoCorrect={false}
          autoComplete="off"
          autoFocus
          editable={!busy}
          style={[
            styles.input,
            styles.codeInput,
            { backgroundColor: theme.backgroundElement, color: theme.text },
          ]}
        />

        <Pressable
          onPress={handleJoin}
          disabled={!canJoin}
          style={[
            styles.button,
            { backgroundColor: theme.backgroundSelected, opacity: canJoin ? 1 : 0.5 },
          ]}>
          <ThemedText type="smallBold">Join</ThemedText>
        </Pressable>

        <Pressable onPress={() => setMode('choose')} disabled={busy} style={styles.switchButton}>
          <ThemedText type="small" themeColor="textSecondary">
            Back
          </ThemedText>
        </Pressable>

        <Status busy={busy} message={message} />
      </Shell>
    );
  }

  return (
    <Shell>
      <ThemedText type="subtitle">Pair up</ThemedText>

      <ThemedText type="small" themeColor="textSecondary">
        Popcorn Pact works with one other person. Invite them, or enter the code
        they sent you.
      </ThemedText>

      <Pressable
        onPress={handleCreate}
        disabled={busy}
        style={[
          styles.button,
          { backgroundColor: theme.backgroundSelected, opacity: busy ? 0.5 : 1 },
        ]}>
        <ThemedText type="smallBold">Invite someone</ThemedText>
      </Pressable>

      <Pressable onPress={() => setMode('join')} disabled={busy} style={styles.switchButton}>
        <ThemedText type="small" themeColor="textSecondary">
          I have a code
        </ThemedText>
      </Pressable>

      <Status busy={busy} message={message} />
    </Shell>
  );
}

function GroupPanel() {
  const theme = useTheme();
  const router = useRouter();
  const { currentGroup, partner, refreshInvite, leaveGroup } = useGroups();

  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  if (!currentGroup) return null;

  const invite = currentGroup.invite;
  const hasRoom = currentGroup.memberCount < currentGroup.memberLimit;

  async function handleNewCode() {
    if (!currentGroup) return;
    setBusy(true);
    setMessage(null);

    const result = await refreshInvite(currentGroup.id);
    if (result.status === 'group_full') setMessage('This group is already full.');
    else if (result.status === 'not_a_member') setMessage('You are not in this group.');
    else if (result.status === 'error') setMessage(result.message);

    setBusy(false);
  }

  async function handleShare() {
    if (!invite) return;
    await Share.share({
      message: `Watch something with me on Popcorn Pact. My code is ${formatCode(invite.code)}.`,
    });
  }

  async function handleLeave() {
    if (!currentGroup) return;
    setBusy(true);
    setMessage(null);

    const { error } = await leaveGroup(currentGroup.id);
    if (error) setMessage(error);

    setBusy(false);
  }

  function handleDone() {
    if (router.canGoBack()) router.back();
  }

  return (
    <Shell>
      <ThemedText type="subtitle">{partner ? "You're paired" : 'Waiting for them'}</ThemedText>

      {partner ? (
        <>
          <ThemedText type="small" themeColor="textSecondary">
            You and {partner.displayName ?? 'your partner'} are ready to start swiping.
          </ThemedText>

          <Pressable
            onPress={handleDone}
            style={[styles.button, { backgroundColor: theme.backgroundSelected }]}>
            <ThemedText type="smallBold">Start swiping</ThemedText>
          </Pressable>
        </>
      ) : (
        <>
          <ThemedText type="small" themeColor="textSecondary">
            Send this code to the person you want to watch with. It works once.
          </ThemedText>

          {invite ? (
            <ThemedView type="backgroundElement" style={styles.card}>
              <ThemedText type="title" style={styles.code}>
                {formatCode(invite.code)}
              </ThemedText>
              <ThemedText type="small" themeColor="textSecondary" style={styles.message}>
                {expiryLabel(invite.expiresAt)}
              </ThemedText>
            </ThemedView>
          ) : (
            <ThemedText type="small" themeColor="textSecondary">
              {hasRoom
                ? 'This group has no active code right now.'
                : 'This group is full, so new codes are unavailable.'}
            </ThemedText>
          )}

          {invite && (
            <Pressable
              onPress={handleShare}
              disabled={busy}
              style={[
                styles.button,
                { backgroundColor: theme.backgroundSelected, opacity: busy ? 0.5 : 1 },
              ]}>
              <ThemedText type="smallBold">Share code</ThemedText>
            </Pressable>
          )}

          {hasRoom && (
            <Pressable onPress={handleNewCode} disabled={busy} style={styles.switchButton}>
              <ThemedText type="small" themeColor="textSecondary">
                Get a new code
              </ThemedText>
            </Pressable>
          )}
        </>
      )}

      <Pressable onPress={handleLeave} disabled={busy} style={styles.switchButton}>
        <ThemedText type="small" themeColor="textSecondary">
          Leave group
        </ThemedText>
      </Pressable>

      <Status busy={busy} message={message} />
    </Shell>
  );
}

function Status({ busy, message }: { busy: boolean; message: string | null }) {
  return (
    <>
      {busy && (
        <ThemedText type="small" themeColor="textSecondary" style={styles.message}>
          Working…
        </ThemedText>
      )}

      {message && (
        <ThemedText type="small" themeColor="textSecondary" style={styles.message}>
          {message}
        </ThemedText>
      )}
    </>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <ThemedView style={styles.container}>
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <SafeAreaView style={styles.safeArea}>{children}</SafeAreaView>
      </KeyboardAvoidingView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  safeArea: {
    flex: 1,
    justifyContent: 'center',
    alignSelf: 'center',
    width: '100%',
    maxWidth: MaxContentWidth,
    paddingHorizontal: Spacing.four,
    gap: Spacing.three,
  },
  input: {
    borderRadius: Spacing.two,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.three,
    fontSize: 16,
  },
  codeInput: {
    textAlign: 'center',
    letterSpacing: 4,
    fontSize: 24,
  },
  card: {
    borderRadius: Spacing.three,
    padding: Spacing.four,
    alignItems: 'center',
    gap: Spacing.two,
  },
  code: {
    letterSpacing: 4,
  },
  button: {
    borderRadius: Spacing.two,
    paddingVertical: Spacing.three,
    alignItems: 'center',
  },
  switchButton: {
    alignItems: 'center',
  },
  message: {
    textAlign: 'center',
  },
});
