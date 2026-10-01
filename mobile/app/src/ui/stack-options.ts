import type { NativeStackNavigationOptions } from 'expo-router/native-stack';

/** Screen options every stack in the app shares. Screens set their own `title`. */
export const stackScreenOptions: NativeStackNavigationOptions = {
  headerBackButtonDisplayMode: 'minimal',
};
