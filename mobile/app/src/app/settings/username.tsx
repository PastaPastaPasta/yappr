import { Stack, router } from 'expo-router'
import { useState } from 'react'
import { TextInput, View } from 'react-native'
import { engine } from '~/engine'
import { Button } from '~/ui/Button'
import { Screen } from '~/ui/Screen'
import { Text } from '~/ui/Text'
import { toast } from '~/ui/toast'
import { tw } from '~/ui/tokens'

export default function UsernameScreen() {
  const [label, setLabel] = useState('')
  const [checking, setChecking] = useState(false)
  const [availability, setAvailability] = useState<{ available: boolean; contested: boolean; error?: string } | null>(null)
  const check = () => {
    setChecking(true)
    engine.api.dpns.check(label).then(setAvailability).catch((error: unknown) => setAvailability({ available: false, contested: false, error: error instanceof Error ? error.message : 'Could not check that name' })).finally(() => setChecking(false))
  }
  const register = () => engine.api.dpns.register(label).then(() => { toast.success('Username registration submitted'); router.back() }).catch((error: unknown) => toast.error(error instanceof Error ? error.message : 'Could not register that username'))
  return <Screen>
    <Stack.Screen options={{ title: 'Choose a username' }} />
    <View className="gap-4 p-4">
      <Text variant="body" tone="secondary">Pick a name people can use to find you. Names with fewer than 20 characters may require a network vote and an extra fee.</Text>
      <TextInput value={label} onChangeText={setLabel} autoCapitalize="none" autoCorrect={false} placeholder="username" accessibilityLabel="Username" className={`min-h-[52px] rounded-lg border px-3 text-base ${tw.border}`} />
      <Button label={checking ? 'Checking…' : 'Check availability'} size="block" onPress={check} disabled={!label.trim() || checking} />
      {availability ? <View className="gap-2"><Text variant="bodyStrong">{availability.error ?? (availability.available ? 'Available' : 'Already taken')}</Text>{availability.contested ? <Text variant="subhead" tone="secondary">This name is contested. Registration may cost more while the community vote is open.</Text> : null}<Button label="Register username" size="block" onPress={register} disabled={!availability.available} /></View> : null}
    </View>
  </Screen>
}
