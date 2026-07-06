/**
 * WARNING!!!
 * The tests in this unit are supposed to run sequentially because they depend on the Matterbridge/Matter state.
 * Is not possible for timing reasons to create and destroy a Matter node each test to keep isolation.
 */

import path from 'node:path';

import type { MatterbridgeEndpoint, PlatformMatterbridge } from 'matterbridge';
import { AnsiLogger, LogLevel } from 'matterbridge/logger';
import { VendorId } from 'matterbridge/matter';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import initializePlugin, { DaikinOnectaPlatform, type DaikinOnectaPlatformConfig } from '../src/module.js';
import { RateLimitedError, type DaikinCloudDevice, type OnectaBridge } from '../src/onecta.js';

const mockMatterbridge: PlatformMatterbridge = {
  systemInformation: {
    interfaceName: 'eth0',
    macAddress: 'aa:bb:cc:dd:ee:ff',
    ipv4Address: '192.168.1.1',
    ipv6Address: 'fd78:cbf8:4939:746:a96:8277:346f:416e',
    osRelease: 'x.y.z',
    nodeVersion: '22.10.0',
    hostname: 'matterbridge',
    user: 'vitest',
    osType: 'Linux',
    osPlatform: 'linux',
    osArch: 'x64',
    totalMemory: '0 B',
    freeMemory: '0 B',
    systemUptime: '0s',
    processUptime: '0s',
    cpuUsage: '0%',
    processCpuUsage: '0%',
    rss: '0 B',
    heapTotal: '0 B',
    heapUsed: '0 B',
  },
  uuid: '00000000-0000-0000-0000-000000000000',
  rootDirectory: path.join('.cache', 'vitest', 'DaikinOnectaPlugin'),
  homeDirectory: path.join('.cache', 'vitest', 'DaikinOnectaPlugin'),
  matterbridgeDirectory: path.join('.cache', 'vitest', 'DaikinOnectaPlugin', '.matterbridge'),
  matterbridgePluginDirectory: path.join('.cache', 'vitest', 'DaikinOnectaPlugin', 'Matterbridge'),
  matterbridgeCertDirectory: path.join('.cache', 'vitest', 'DaikinOnectaPlugin', '.mattercert'),
  globalModulesDirectory: path.join('.cache', 'vitest', 'DaikinOnectaPlugin', 'node_modules'),
  matterbridgeVersion: '3.9.0',
  matterbridgeLatestVersion: '3.9.0',
  matterbridgeDevVersion: '3.9.0',
  frontendVersion: '3.0.0',
  bridgeMode: 'bridge',
  restartMode: 'docker',
  virtualMode: 'mounted_switch',
  aggregatorVendorId: VendorId(0xfff1),
  aggregatorVendorName: 'Matterbridge',
  aggregatorProductId: 0x8000,
  aggregatorProductName: 'Matterbridge Vitest Aggregator',
};

const mockLog = {
  fatal: vi.fn((message: string, ...parameters: any[]) => {}),
  error: vi.fn((message: string, ...parameters: any[]) => {}),
  warn: vi.fn((message: string, ...parameters: any[]) => {}),
  notice: vi.fn((message: string, ...parameters: any[]) => {}),
  info: vi.fn((message: string, ...parameters: any[]) => {}),
  debug: vi.fn((message: string, ...parameters: any[]) => {}),
} as unknown as AnsiLogger;

const mockConfig: DaikinOnectaPlatformConfig = {
  name: 'matterbridge-daikin-onecta',
  type: 'DynamicPlatform',
  version: '0.1.0',
  clientId: '',
  clientSecret: '',
  callbackPort: 8582,
  pollingIntervalDay: 10,
  pollingIntervalNight: 30,
  dayStart: '07:00',
  dayEnd: '22:00',
  exposeOutdoorTemperature: true,
  exposeFan: true,
  whiteList: [],
  blackList: [],
  debug: false,
  unregisterOnShutdown: false,
};

// Mocked methods
const addBridgedEndpoint = vi.fn(async (pluginName: string, device: MatterbridgeEndpoint) => {});
const removeBridgedEndpoint = vi.fn(async (pluginName: string, device: MatterbridgeEndpoint) => {});
const removeAllBridgedEndpoints = vi.fn(async (pluginName: string) => {});
const registerVirtualDevice = vi.fn(async (name: string, type: 'light' | 'outlet' | 'switch' | 'mounted_switch', callback: () => Promise<void>) => {});

// Mock the logger
const loggerLogSpy = vi.spyOn(AnsiLogger.prototype, 'log').mockImplementation((level: string, message: string, ...parameters: any[]) => {});

const fakeDevice = {
  getId: () => 'gw-1',
  isCloudConnectionUp: () => true,
  getDescription: () => ({
    deviceModel: 'Split AC',
    managementPoints: [{ embeddedId: 'climateControl', managementPointType: 'climateControl', onOffMode: { value: 'on' } }],
  }),
} as unknown as DaikinCloudDevice;

const refreshMock = vi.fn<() => Promise<DaikinCloudDevice[]>>(async () => [fakeDevice]);

/** Platform with the Onecta client replaced by a fake, so no network or OAuth is involved. */
class TestPlatform extends DaikinOnectaPlatform {
  protected override createClient(): OnectaBridge {
    return { refresh: refreshMock, rateLimit: {} } as unknown as OnectaBridge;
  }
}

describe('Matterbridge Daikin Onecta plugin', () => {
  let instance: DaikinOnectaPlatform;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  it('should throw an error if matterbridge is not the required version', () => {
    expect(() => new DaikinOnectaPlatform({ ...mockMatterbridge, matterbridgeVersion: '2.0.0' }, mockLog, mockConfig)).toThrow(
      'This plugin requires Matterbridge version >= "3.9.0". Please update Matterbridge from 2.0.0 to the latest version in the frontend.',
    );
  });

  it('should create an instance of the platform with the default export', async () => {
    const platform = initializePlugin(mockMatterbridge, mockLog, mockConfig);
    expect(platform).toBeInstanceOf(DaikinOnectaPlatform);
    expect(platform.matterbridge).toBe(mockMatterbridge);
    expect(platform.log).toBe(mockLog);
    expect(platform.config).toBe(mockConfig);
    expect(mockLog.info).toHaveBeenCalledWith('Initializing Daikin Onecta platform...');
    await platform.onShutdown();
  });

  it('should log an error and not poll when credentials are missing', async () => {
    instance = new TestPlatform(mockMatterbridge, mockLog, mockConfig);
    // @ts-expect-error Accessing private method for testing purposes
    instance.setMatterNode(addBridgedEndpoint, removeBridgedEndpoint, removeAllBridgedEndpoints, registerVirtualDevice);
    await instance.onStart('Vitest');
    expect(mockLog.info).toHaveBeenCalledWith('onStart called with reason: Vitest');
    expect(mockLog.error).toHaveBeenCalledWith(expect.stringContaining('Daikin Onecta credentials are not configured'));
    expect(refreshMock).not.toHaveBeenCalled();
    await instance.onShutdown();
  });

  it('should fetch and log devices when credentials are configured', async () => {
    mockConfig.clientId = 'client-id';
    mockConfig.clientSecret = 'client-secret';
    instance = new TestPlatform(mockMatterbridge, mockLog, mockConfig);
    // @ts-expect-error Accessing private method for testing purposes
    instance.setMatterNode(addBridgedEndpoint, removeBridgedEndpoint, removeAllBridgedEndpoints, registerVirtualDevice);
    await instance.onStart();
    expect(mockLog.info).toHaveBeenCalledWith('onStart called with reason: none');
    expect(refreshMock).toHaveBeenCalledTimes(1);
    expect(mockLog.info).toHaveBeenCalledWith('Fetched 1 Daikin gateway device(s) from the Onecta cloud:');
    expect(mockLog.info).toHaveBeenCalledWith('Gateway device gw-1 (model: Split AC, connected: true)');
    expect(mockLog.debug).toHaveBeenCalledWith(expect.stringContaining('Next Daikin Onecta poll in'));
  });

  it('should configure', async () => {
    await instance.onConfigure();
    expect(mockLog.info).toHaveBeenCalledWith('onConfigure called');
  });

  it('should change logger level', async () => {
    await instance.onChangeLoggerLevel(LogLevel.DEBUG);
    expect(mockLog.info).toHaveBeenCalledWith('onChangeLoggerLevel called with: debug');
  });

  it('should schedule a long retry when the API rate limit is reached', async () => {
    refreshMock.mockRejectedValueOnce(new RateLimitedError('rate limited', 1800));
    await instance.onStart('Vitest');
    expect(mockLog.warn).toHaveBeenCalledWith(expect.stringContaining('daily rate limit reached'));
    expect(mockLog.warn).toHaveBeenCalledWith(expect.stringContaining('30 minutes'));
  });

  it('should schedule a retry when fetching devices fails', async () => {
    refreshMock.mockRejectedValueOnce(new Error('boom'));
    await instance.onStart('Vitest');
    expect(mockLog.error).toHaveBeenCalledWith(expect.stringContaining('Fetching Daikin devices failed: boom'));
  });

  it('should shutdown', async () => {
    await instance.onShutdown('Vitest');
    expect(mockLog.info).toHaveBeenCalledWith('onShutdown called with reason: Vitest');
    expect(removeAllBridgedEndpoints).not.toHaveBeenCalled();

    // Mock the unregisterOnShutdown behavior
    mockConfig.unregisterOnShutdown = true;
    await instance.onShutdown();
    expect(mockLog.info).toHaveBeenCalledWith('onShutdown called with reason: none');
    expect(removeAllBridgedEndpoints).toHaveBeenCalled();
    mockConfig.unregisterOnShutdown = false;
    mockConfig.clientId = '';
    mockConfig.clientSecret = '';
  });
});
