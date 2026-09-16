import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir:'./tests', timeout:45_000, expect:{timeout:8_000}, workers:1, fullyParallel:false, retries:0,
  reporter:'list', outputDir:'../../.artifacts/browser-tests',
  use:{browserName:'chromium',headless:true,viewport:{width:1440,height:1000},trace:'off',video:'off',screenshot:'off'},
});
