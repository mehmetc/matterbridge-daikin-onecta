/**
 * Matterbridge dynamic platform for Daikin Onecta cloud devices.
 *
 * @file platform.ts
 * @author Mehmet Celik
 * @license Apache-2.0
 */

import path from 'node:path';

import { type BasePlatformConfig, MatterbridgeDynamicPlatform, type PlatformMatterbridge } from 'matterbridge';
import type { AnsiLogger, LogLevel } from 'matterbridge/logger';

import { OnectaBridge, RateLimitedError } from './onecta.js';
import { formatDeviceTree, pollDelayMs } from './utils.js';

export type DaikinOnectaPlatformConfig = BasePlatformConfig & {
  clientId: string;
  clientSecret: string;
  callbackPort: number;
  externalAddress?: string;
  pollingIntervalDay: number;
  pollingIntervalNight: number;
  dayStart: string;
  dayEnd: string;
  exposeOutdoorTemperature: boolean;
  exposeFan: boolean;
  whiteList: string[];
  blackList: string[];
};

/** Delay before retrying after a failed discovery or poll (auth timeout, network error, ...). */
const RETRY_DELAY_MS = 5 * 60_000;

export class DaikinOnectaPlatform extends MatterbridgeDynamicPlatform {
  private readonly onecta: DaikinOnectaPlatformConfig;
  private client: OnectaBridge | undefined;
  private pollTimer: NodeJS.Timeout | undefined;
  private stopped = false;
  private refreshing = false;

  constructor(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: DaikinOnectaPlatformConfig) {
    super(matterbridge, log, config);

    if (typeof this.verifyMatterbridgeVersion !== 'function' || !this.verifyMatterbridgeVersion('3.9.0')) {
      throw new Error(
        `This plugin requires Matterbridge version >= "3.9.0". Please update Matterbridge from ${this.matterbridge.matterbridgeVersion} to the latest version in the frontend.`,
      );
    }

    this.onecta = config;
    this.log.info('Initializing Daikin Onecta platform...');
  }

  override async onStart(reason?: string): Promise<void> {
    this.log.info(`onStart called with reason: ${reason ?? 'none'}`);

    await this.ready;
    await this.clearSelect();

    if (!this.onecta.clientId || !this.onecta.clientSecret) {
      this.log.error(
        'Daikin Onecta credentials are not configured. Create an app on the Daikin Developer Portal (https://developer.cloud.daikineurope.com), ' +
          'then enter its Client ID and Client Secret in the plugin config and restart the plugin.',
      );
      return;
    }

    this.stopped = false;
    this.client = this.createClient();
    await this.refreshDevices();
  }

  override async onConfigure(): Promise<void> {
    await super.onConfigure();
    this.log.info('onConfigure called');
  }

  // oxlint-disable-next-line typescript/require-await
  override async onChangeLoggerLevel(logLevel: LogLevel): Promise<void> {
    this.log.info(`onChangeLoggerLevel called with: ${logLevel}`);
  }

  override async onShutdown(reason?: string): Promise<void> {
    await super.onShutdown(reason);
    this.log.info(`onShutdown called with reason: ${reason ?? 'none'}`);
    // In-flight authorization attempts cannot be aborted (the library offers no cancel API);
    // `stopped` makes sure their continuations never log or schedule on this dead instance.
    this.stopped = true;
    clearTimeout(this.pollTimer);
    this.pollTimer = undefined;
    if (this.config.unregisterOnShutdown) await this.unregisterAllDevices();
  }

  /**
   * Overridable factory so tests can inject a fake OnectaBridge.
   *
   * @returns {OnectaBridge} The Onecta cloud client.
   */
  protected createClient(): OnectaBridge {
    return new OnectaBridge(
      {
        clientId: this.onecta.clientId,
        clientSecret: this.onecta.clientSecret,
        callbackPort: this.onecta.callbackPort ?? 8582,
        // `||`, not `??`: an empty string in the config must fall back to the detected LAN address.
        // oxlint-disable-next-line typescript/prefer-nullish-coalescing
        externalAddress: this.onecta.externalAddress || this.matterbridge.systemInformation.ipv4Address,
        tokenSetFilePath: path.join(this.matterbridge.matterbridgeDirectory, `${this.onecta.name}.tokenset.json`),
      },
      this.log,
    );
  }

  /** Fetch all devices with one API call, log the result and schedule the next poll. */
  private async refreshDevices(): Promise<void> {
    if (!this.client || this.stopped) return;
    if (this.refreshing) {
      // A refresh (possibly a first-time authorization taking up to 10 minutes) is already
      // in flight; starting another one would collide on the OAuth callback port.
      this.log.debug('Skipping refresh: a previous refresh is still in flight.');
      return;
    }
    this.refreshing = true;
    try {
      const devices = await this.client.refresh();
      if (this.stopped) return;
      this.log.info(`Fetched ${devices.length} Daikin gateway device(s) from the Onecta cloud:`);
      for (const line of formatDeviceTree(devices)) this.log.info(line);
      this.schedulePoll();
    } catch (error) {
      if (this.stopped) return;
      if (error instanceof RateLimitedError) {
        const delay = (error.retryAfter ?? 3600) * 1000;
        this.log.warn(`Daikin Onecta API daily rate limit reached. Next poll in ${Math.round(delay / 60_000)} minutes.`);
        this.schedulePoll(delay);
      } else {
        this.log.error(`Fetching Daikin devices failed: ${error instanceof Error ? error.message : String(error)}. Retrying in ${RETRY_DELAY_MS / 60_000} minutes.`);
        this.schedulePoll(RETRY_DELAY_MS);
      }
    } finally {
      this.refreshing = false;
    }
  }

  private schedulePoll(delayMs?: number): void {
    if (this.stopped) return;
    clearTimeout(this.pollTimer);
    const delay = delayMs ?? pollDelayMs(this.onecta);
    this.log.debug(`Next Daikin Onecta poll in ${Math.round(delay / 1000)}s`);
    this.pollTimer = setTimeout(() => {
      void this.refreshDevices();
    }, delay);
    this.pollTimer.unref?.();
  }
}
