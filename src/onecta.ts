/**
 * Thin wrapper around daikin-controller-cloud that isolates the plugin from the
 * library API and centralizes logging of authorization, token and rate-limit events.
 *
 * @file onecta.ts
 * @author Mehmet Celik
 * @license Apache-2.0
 */

import { DaikinCloudController, RateLimitedError } from 'daikin-controller-cloud';
import type { DaikinCloudDevice } from 'daikin-controller-cloud/dist/device.js';
import type { OnectaRateLimitStatus } from 'daikin-controller-cloud/dist/onecta/oidc-utils.js';
import type { AnsiLogger } from 'matterbridge/logger';

export { RateLimitedError };
export type { DaikinCloudDevice, OnectaRateLimitStatus };

export interface OnectaBridgeOptions {
  clientId: string;
  clientSecret: string;
  /** Port for the local HTTPS OIDC callback server. Must match the redirect URI registered on the Daikin Developer Portal. */
  callbackPort: number;
  /** Address of this machine as reachable from the user's browser. Defaults to the detected LAN address. */
  externalAddress?: string;
  /** Where the OIDC token set is persisted between restarts. */
  tokenSetFilePath: string;
  /** Seconds the user has to complete the browser authorization. */
  authTimeoutS?: number;
}

export class OnectaBridge {
  private readonly controller: DaikinCloudController;
  private readonly log: AnsiLogger;
  private rateLimitStatus: OnectaRateLimitStatus = {};

  constructor(options: OnectaBridgeOptions, log: AnsiLogger) {
    this.log = log;
    this.controller = new DaikinCloudController({
      oidcClientId: options.clientId,
      oidcClientSecret: options.clientSecret,
      oidcCallbackServerPort: options.callbackPort,
      oidcCallbackServerBindAddr: '0.0.0.0',
      oidcCallbackServerExternalAddress: options.externalAddress,
      oidcTokenSetFilePath: options.tokenSetFilePath,
      oidcAuthorizationTimeoutS: options.authTimeoutS ?? 600,
    });

    this.controller.on('authorization_request', (url: string) => {
      this.log.notice(`Daikin Onecta authorization required:`);
      this.log.notice(`1. On the Daikin Developer Portal (https://developer.cloud.daikineurope.com) make sure your app has "${url}" registered as redirect URI.`);
      this.log.notice(`2. Open ${url} in a browser on this network and accept the self-signed certificate warning.`);
      this.log.notice(`3. Sign in with your Daikin account and grant access. The request times out after ${(options.authTimeoutS ?? 600) / 60} minutes.`);
    });
    this.controller.on('token_update', () => {
      this.log.debug('Daikin Onecta OIDC token set updated and persisted.');
    });
    this.controller.on('rate_limit_status', (status: OnectaRateLimitStatus) => {
      this.rateLimitStatus = status;
      if (status.remainingDay !== undefined) {
        this.log.debug(`Daikin Onecta API budget: ${status.remainingDay}/${status.limitDay ?? '?'} calls remaining today.`);
      }
    });
    this.controller.on('error', (error: Error | string) => {
      this.log.error(`Daikin Onecta client error: ${error instanceof Error ? error.message : error}`);
    });
  }

  /**
   * Last rate-limit status reported by the Onecta API.
   *
   * @returns {OnectaRateLimitStatus} The most recent rate-limit headers.
   */
  get rateLimit(): OnectaRateLimitStatus {
    return this.rateLimitStatus;
  }

  /**
   * Fetch (or refresh) all devices with a single GET /v1/gateway-devices call.
   * Device instances are cached by the controller and updated in place, so the
   * returned objects are stable across calls.
   *
   * @returns {Promise<DaikinCloudDevice[]>} All gateway devices of the account.
   */
  async refresh(): Promise<DaikinCloudDevice[]> {
    return this.controller.getCloudDevices();
  }
}
