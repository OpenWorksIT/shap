import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'za.co.openworks.shappocket',
  appName: 'Shap Pocket',
  webDir: 'dist',
  backgroundColor: '#f5f2ed',
  ios: { contentInset: 'never', scheme: 'Shap Pocket' },
  android: { allowMixedContent: false },
  plugins: {
    SplashScreen: { launchShowDuration: 600, backgroundColor: '#f5f2ed', showSpinner: false },
  },
};

export default config;
