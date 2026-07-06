/**
 * Matterbridge plugin entry point for matterbridge-daikin-onecta.
 *
 * @file module.ts
 * @author Mehmet Celik
 * @license Apache-2.0
 */

import type { PlatformMatterbridge } from 'matterbridge';
import type { AnsiLogger } from 'matterbridge/logger';

import { DaikinOnectaPlatform, type DaikinOnectaPlatformConfig } from './platform.js';

export { DaikinOnectaPlatform, type DaikinOnectaPlatformConfig } from './platform.js';
export { formatDeviceTree, isDaytime, parseHHMM, pollDelayMs, type DeviceLike, type PollingConfig } from './utils.js';
export { endpointSerial, parseClimateStates, toFanPercent, toMatterTemperature, type ClimateState, type FanState, type SetpointRange } from './mapper.js';

/**
 * Standard Matterbridge plugin entry point.
 *
 * @param {PlatformMatterbridge} matterbridge - The Matterbridge instance.
 * @param {AnsiLogger} log - Logger for messages shown in the console and frontend.
 * @param {DaikinOnectaPlatformConfig} config - The platform configuration.
 * @returns {DaikinOnectaPlatform} The initialized platform.
 */
export default function initializePlugin(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: DaikinOnectaPlatformConfig): DaikinOnectaPlatform {
  return new DaikinOnectaPlatform(matterbridge, log, config);
}
