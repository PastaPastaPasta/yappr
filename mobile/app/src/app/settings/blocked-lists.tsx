import { Stack } from 'expo-router'
import { useEffect, useState } from 'react'
import { TextInput, View } from 'react-native'
import { engine } from '~/engine'
import { useSession } from '~/data/session'
import { Button } from '~/ui/Button'
import { Screen } from '~/ui/Screen'
import { Text } from '~/ui/Text'
import { toast } from '~/ui/toast'
import { tw } from '~/ui/tokens'

export default function BlockedListsScreen() {
  const { signedIn } = useSession()
  const [ids, setIds] = useState<string[]>([])
  const [target, setTarget] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const load = () => engine.api.safety.followedBlockListIds().then(setIds).catch(() => toast.error('Could not load block lists'))
  useEffect(() => { if (signedIn) load() }, [signedIn])
  const change = (id: string, follow: boolean) => {
    setBusy(id)
    const op = follow ? engine.api.safety.followBlockList(id) : engine.api.safety.unfollowBlockList(id)
    op.then(() => {
      setIds(current => follow ? [...current, id] : current.filter(item => item !== id))
      setTarget('')
      toast.success(follow ? 'Block list followed' : 'Block list unfollowed')
    }).catch((error: unknown) => toast.error(error instanceof Error ? error.message : 'Could not update block list')).finally(() => setBusy(null))
  }
  return (
    <Screen>
      <Stack.Screen options={{ title: 'Block lists' }} />
      <View className="gap-4 p-4">
        <Text variant="headline">Block lists</Text>
        {!signedIn ? <Text variant="body" tone="secondary">Sign in to manage the block lists you follow.</Text> : (
          <>
            <Text variant="body" tone="secondary">Follow a person’s block list to hide accounts they block.</Text>
            <View className="gap-2">
              <TextInput value={target} onChangeText={setTarget} autoCapitalize="none" placeholder="Identity ID" accessibilityLabel="Block list identity" className={`min-h-[52px] rounded-lg border px-3 text-base ${tw.border}`} />
              <Button label="Follow block list" size="block" onPress={() => change(target.trim(), true)} disabled={!target.trim() || busy !== null || ids.includes(target.trim())} />
            </View>
            <View className="gap-2">
              {ids.length ? ids.map(id => <View key={id} className="flex-row items-center justify-between gap-2"><Text variant="subhead" className="flex-1">{id}</Text><Button label="Unfollow" size="sm" variant="outline" onPress={() => change(id, false)} disabled={busy !== null} /></View>) : <Text variant="body" tone="secondary">You are not following any block lists.</Text>}
            </View>
          </>
        )}
      </View>
    </Screen>
  )
}
