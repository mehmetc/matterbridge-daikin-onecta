/**
 * Matterbridge dynamic platform for Daikin Onecta cloud devices.
 *
 * @file platform.ts
 * @author Mehmet Celik
 * @license Apache-2.0
 */

import path from 'node:path';

import {
  type BasePlatformConfig,
  MatterbridgeDynamicPlatform,
  MatterbridgeEndpoint,
  type PlatformMatterbridge,
  fan,
  humiditySensor,
  mountedOnOffControl,
  temperatureSensor,
  thermostat,
} from 'matterbridge';
import type { AnsiLogger, LogLevel } from 'matterbridge/logger';
import type { ActionContext } from 'matterbridge/matter';
import { FanControl, OnOff, RelativeHumidityMeasurement, TemperatureMeasurement, Thermostat } from 'matterbridge/matter/clusters';

import { type ClimateState, endpointSerial, parseClimateStates, toFanPercent, toMatterTemperature } from './mapper.js';
import { type DaikinCloudDevice, OnectaBridge, RateLimitedError } from './onecta.js';
import { formatDeviceTree, pollDelayMs } from './utils.js';
import { type WriteCommand, applyWriteToState, planFanModeChange, planFanPercentChange, planPowerfulChange, planSetpointChange, planSystemModeChange } from './writes.js';

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
  exposeSwitches: boolean;
  whiteList: string[];
  blackList: string[];
};

/** Delay before retrying after a failed discovery or poll (auth timeout, network error, ...). */
const RETRY_DELAY_MS = 5 * 60_000;

/** Debounce window for controller writes: a setpoint drag becomes a single PATCH. */
const WRITE_DEBOUNCE_MS = 1500;

/** Delay before polling after a failed write, to resync the Matter state with reality. */
const RESYNC_DELAY_MS = 30_000;

export class DaikinOnectaPlatform extends MatterbridgeDynamicPlatform {
  private readonly onecta: DaikinOnectaPlatformConfig;
  private client: OnectaBridge | undefined;
  private pollTimer: NodeJS.Timeout | undefined;
  private stopped = false;
  private refreshing = false;
  private discovered = false;
  /** Registered endpoints keyed by their serial. */
  private readonly endpoints = new Map<string, MatterbridgeEndpoint>();
  /** Latest parsed state per climateControl serial, applied in onConfigure and on each poll. */
  private readonly lastStates = new Map<string, ClimateState>();
  /** Cloud device handles keyed by gateway id, used to send commands. */
  private readonly cloudDevices = new Map<string, DaikinCloudDevice>();
  /** Debounce timers and pending commands for controller writes, keyed by gatewayId:kind. */
  private readonly writeTimers = new Map<string, NodeJS.Timeout>();
  private readonly pendingWrites = new Map<string, WriteCommand[]>();
  /** Serializes command PATCHes so they never run concurrently. */
  private writeChain: Promise<void> = Promise.resolve();

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
    // The server node is online now: (re)apply the latest known state to all endpoints.
    for (const state of this.lastStates.values()) {
      await this.applyState(state);
    }
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
    for (const timer of this.writeTimers.values()) clearTimeout(timer);
    this.writeTimers.clear();
    this.pendingWrites.clear();
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

  /** Fetch all devices with one API call, create or update endpoints and schedule the next poll. */
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
      if (!this.discovered) {
        this.log.info(`Fetched ${devices.length} Daikin gateway device(s) from the Onecta cloud:`);
        for (const line of formatDeviceTree(devices)) this.log.info(line);
      }
      for (const device of devices) this.cloudDevices.set(device.getId(), device);
      const states = devices.flatMap((device) => parseClimateStates(device.getDescription()));
      for (const state of states) {
        const apply = this.discovered;
        if (!this.discovered) await this.createClimateEndpoints(state);
        this.lastStates.set(endpointSerial(state.gatewayId, 'CC'), state);
        // During discovery the initial values are baked into the clusters and the server node
        // is not online yet; onConfigure re-applies them once it is.
        if (apply) await this.applyState(state);
      }
      this.discovered = true;
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

  /**
   * Create and register the Matter endpoints (thermostat, outdoor sensor, fan) for one AC unit.
   *
   * @param {ClimateState} state - The parsed climate state.
   */
  private async createClimateEndpoints(state: ClimateState): Promise<void> {
    const ccSerial = endpointSerial(state.gatewayId, 'CC');
    const heat = state.heatingSetpoint ?? state.autoSetpoint;
    const cool = state.coolingSetpoint ?? state.autoSetpoint;

    const thermostatEndpoint = new MatterbridgeEndpoint(thermostat, { id: ccSerial })
      .createDefaultBridgedDeviceBasicInformationClusterServer(state.name, ccSerial, this.matterbridge.aggregatorVendorId, 'Daikin', 'Onecta Air Conditioner', 1, '0.1.0')
      .createDefaultPowerSourceWiredClusterServer()
      // Note: this helper takes °C (it converts internally), unlike updateAttribute which takes centi-degrees.
      // Deadband 0: Daikin allows equal heating and cooling setpoints.
      .createDefaultThermostatClusterServer(
        state.roomTemperature ?? 20,
        heat?.value ?? 20,
        cool?.value ?? 25,
        0,
        heat?.min ?? 10,
        heat?.max ?? 30,
        cool?.min ?? 18,
        cool?.max ?? 33,
      )
      .addRequiredClusters()
      .subscribeAttribute(Thermostat, 'systemMode', (newValue: Thermostat.SystemMode, oldValue: Thermostat.SystemMode, context: ActionContext) => {
        if (context.fabric === undefined) return; // Our own update, not a controller command.
        this.handleWrite(state.gatewayId, 'mode', (current) => planSystemModeChange(current, newValue), `system mode ${newValue}`);
      })
      .subscribeAttribute(Thermostat, 'occupiedHeatingSetpoint', (newValue: number, oldValue: number, context: ActionContext) => {
        if (context.fabric === undefined) return;
        this.handleWrite(state.gatewayId, 'heatSetpoint', (current) => planSetpointChange(current, 'heating', newValue / 100), `heating setpoint ${newValue / 100} °C`);
      })
      .subscribeAttribute(Thermostat, 'occupiedCoolingSetpoint', (newValue: number, oldValue: number, context: ActionContext) => {
        if (context.fabric === undefined) return;
        this.handleWrite(state.gatewayId, 'coolSetpoint', (current) => planSetpointChange(current, 'cooling', newValue / 100), `cooling setpoint ${newValue / 100} °C`);
      });
    await this.registerEndpoint(thermostatEndpoint, state.name, ccSerial);

    if (this.onecta.exposeOutdoorTemperature && state.outdoorTemperature !== undefined) {
      const otSerial = endpointSerial(state.gatewayId, 'OT');
      const sensor = new MatterbridgeEndpoint(temperatureSensor, { id: otSerial })
        .createDefaultBridgedDeviceBasicInformationClusterServer(
          `${state.name} Outdoor`,
          otSerial,
          this.matterbridge.aggregatorVendorId,
          'Daikin',
          'Onecta Outdoor Sensor',
          1,
          '0.1.0',
        )
        .createDefaultTemperatureMeasurementClusterServer(toMatterTemperature(state.outdoorTemperature), -5000, 6000)
        .addRequiredClusters();
      await this.registerEndpoint(sensor, `${state.name} Outdoor`, otSerial);
    }

    if (state.roomHumidity !== undefined) {
      const humSerial = endpointSerial(state.gatewayId, 'HUM');
      const humidity = new MatterbridgeEndpoint(humiditySensor, { id: humSerial })
        .createDefaultBridgedDeviceBasicInformationClusterServer(
          `${state.name} Humidity`,
          humSerial,
          this.matterbridge.aggregatorVendorId,
          'Daikin',
          'Onecta Humidity Sensor',
          1,
          '0.1.0',
        )
        .createDefaultRelativeHumidityMeasurementClusterServer(Math.round(state.roomHumidity * 100))
        .addRequiredClusters();
      await this.registerEndpoint(humidity, `${state.name} Humidity`, humSerial);
    }

    if (this.onecta.exposeSwitches && state.powerful !== undefined) {
      const pwrSerial = endpointSerial(state.gatewayId, 'PWR');
      const powerfulSwitch = new MatterbridgeEndpoint(mountedOnOffControl, { id: pwrSerial })
        .createDefaultBridgedDeviceBasicInformationClusterServer(
          `${state.name} Powerful`,
          pwrSerial,
          this.matterbridge.aggregatorVendorId,
          'Daikin',
          'Onecta Powerful Mode',
          1,
          '0.1.0',
        )
        .createDefaultOnOffClusterServer(state.powerful)
        .addRequiredClusters()
        .addCommandHandler('on', () => {
          this.handleWrite(state.gatewayId, 'powerful', (current) => planPowerfulChange(current, true), 'powerful mode on');
        })
        .addCommandHandler('off', () => {
          this.handleWrite(state.gatewayId, 'powerful', (current) => planPowerfulChange(current, false), 'powerful mode off');
        });
      await this.registerEndpoint(powerfulSwitch, `${state.name} Powerful`, pwrSerial);
    }

    if (this.onecta.exposeFan && state.fan) {
      const fanSerial = endpointSerial(state.gatewayId, 'FAN');
      const percent = state.fan.mode === 'fixed' && state.fan.speed !== undefined ? toFanPercent(state.fan.speed, state.fan.maxSpeed ?? 5) : 0;
      const fanEndpoint = new MatterbridgeEndpoint(fan, { id: fanSerial })
        .createDefaultBridgedDeviceBasicInformationClusterServer(`${state.name} Fan`, fanSerial, this.matterbridge.aggregatorVendorId, 'Daikin', 'Onecta Fan', 1, '0.1.0')
        .createDefaultFanControlClusterServer(this.fanModeFor(state), undefined, percent, percent)
        .addRequiredClusters()
        .subscribeAttribute(FanControl, 'percentSetting', (newValue: number | null, oldValue: number | null, context: ActionContext) => {
          if (context.fabric === undefined) return;
          this.handleWrite(state.gatewayId, 'fan', (current) => planFanPercentChange(current, newValue), `fan ${newValue} %`);
        })
        .subscribeAttribute(FanControl, 'fanMode', (newValue: FanControl.FanMode, oldValue: FanControl.FanMode, context: ActionContext) => {
          if (context.fabric === undefined) return;
          this.handleWrite(state.gatewayId, 'fan', (current) => planFanModeChange(current, newValue), `fan mode ${newValue}`);
        });
      await this.registerEndpoint(fanEndpoint, `${state.name} Fan`, fanSerial);
    }
  }

  /**
   * Validate against the white/black lists and register one endpoint.
   *
   * @param {MatterbridgeEndpoint} endpoint - The endpoint to register.
   * @param {string} name - The user-visible device name.
   * @param {string} serial - The stable serial used as select key.
   */
  private async registerEndpoint(endpoint: MatterbridgeEndpoint, name: string, serial: string): Promise<void> {
    this.setSelectDevice(serial, name);
    if (!this.validateDevice([name, serial])) return;
    await this.registerDevice(endpoint);
    this.endpoints.set(serial, endpoint);
    this.log.info(`Registered Matter endpoint "${name}" (serial ${serial})`);
  }

  /**
   * Push the current Onecta state of one AC unit to its registered Matter endpoints.
   *
   * @param {ClimateState} state - The parsed climate state.
   */
  private async applyState(state: ClimateState): Promise<void> {
    const thermostatEndpoint = this.endpoints.get(endpointSerial(state.gatewayId, 'CC'));
    if (thermostatEndpoint) {
      await thermostatEndpoint.updateAttribute(Thermostat, 'localTemperature', state.roomTemperature === undefined ? null : toMatterTemperature(state.roomTemperature), this.log);
      const heat = state.heatingSetpoint ?? state.autoSetpoint;
      const cool = state.coolingSetpoint ?? state.autoSetpoint;
      if (heat) await thermostatEndpoint.updateAttribute(Thermostat, 'occupiedHeatingSetpoint', toMatterTemperature(heat.value), this.log);
      if (cool) await thermostatEndpoint.updateAttribute(Thermostat, 'occupiedCoolingSetpoint', toMatterTemperature(cool.value), this.log);
      await thermostatEndpoint.updateAttribute(Thermostat, 'systemMode', this.systemModeFor(state), this.log);
    }

    const sensorEndpoint = this.endpoints.get(endpointSerial(state.gatewayId, 'OT'));
    if (sensorEndpoint && state.outdoorTemperature !== undefined) {
      await sensorEndpoint.updateAttribute(TemperatureMeasurement, 'measuredValue', toMatterTemperature(state.outdoorTemperature), this.log);
    }

    const humidityEndpoint = this.endpoints.get(endpointSerial(state.gatewayId, 'HUM'));
    if (humidityEndpoint && state.roomHumidity !== undefined) {
      await humidityEndpoint.updateAttribute(RelativeHumidityMeasurement, 'measuredValue', Math.round(state.roomHumidity * 100), this.log);
    }

    const powerfulEndpoint = this.endpoints.get(endpointSerial(state.gatewayId, 'PWR'));
    if (powerfulEndpoint && state.powerful !== undefined) {
      await powerfulEndpoint.updateAttribute(OnOff, 'onOff', state.powerful, this.log);
    }

    const fanEndpoint = this.endpoints.get(endpointSerial(state.gatewayId, 'FAN'));
    if (fanEndpoint && state.fan) {
      await fanEndpoint.updateAttribute(FanControl, 'fanMode', this.fanModeFor(state), this.log);
      if (state.fan.mode === 'fixed' && state.fan.speed !== undefined) {
        await fanEndpoint.updateAttribute(FanControl, 'percentCurrent', toFanPercent(state.fan.speed, state.fan.maxSpeed ?? 5), this.log);
      }
    }
  }

  /**
   * Handle one controller-initiated change: plan the commands from the cached state
   * and (re)start the debounce window for this write kind.
   *
   * @param {string} gatewayId - The gateway device id.
   * @param {string} kind - Debounce key ("mode", "heatSetpoint", ...); newer plans of the same kind replace older ones.
   * @param {(state: ClimateState) => WriteCommand[]} plan - Planner invoked with the latest cached state.
   * @param {string} description - Human-readable description for the log.
   */
  private handleWrite(gatewayId: string, kind: string, plan: (state: ClimateState) => WriteCommand[], description: string): void {
    const state = this.lastStates.get(endpointSerial(gatewayId, 'CC'));
    if (!state) return;
    const commands = plan(state);
    if (commands.length === 0) {
      this.log.debug(`${state.name}: controller requested ${description}; nothing to send (already matching or unsupported).`);
      return;
    }
    this.log.info(`${state.name}: controller requested ${description}; sending in ${WRITE_DEBOUNCE_MS} ms unless superseded.`);
    const key = `${gatewayId}:${kind}`;
    this.pendingWrites.set(key, commands);
    clearTimeout(this.writeTimers.get(key));
    const timer = setTimeout(() => {
      this.writeTimers.delete(key);
      const pending = this.pendingWrites.get(key);
      this.pendingWrites.delete(key);
      if (!pending || this.stopped) return;
      this.writeChain = this.writeChain.then(async () => this.executeWrite(gatewayId, pending));
    }, WRITE_DEBOUNCE_MS);
    timer.unref?.();
    this.writeTimers.set(key, timer);
  }

  /**
   * Send the planned commands to the Daikin cloud and update the cached state optimistically.
   *
   * @param {string} gatewayId - The gateway device id.
   * @param {WriteCommand[]} commands - The commands to send.
   */
  private async executeWrite(gatewayId: string, commands: WriteCommand[]): Promise<void> {
    const device = this.cloudDevices.get(gatewayId);
    const state = this.lastStates.get(endpointSerial(gatewayId, 'CC'));
    if (!device || !state || this.stopped) return;
    try {
      for (const command of commands) {
        await device.setData(state.embeddedId, command.dataPoint, command.path ?? undefined, command.value, { updateLocalData: true });
        applyWriteToState(state, command);
        this.log.info(`${state.name}: sent ${command.dataPoint}${command.path ?? ''} = ${command.value} to the Daikin cloud.`);
      }
      // Defer the next poll a full interval: the write is reflected optimistically and
      // polling too early can return stale data that would revert the Matter state.
      this.schedulePoll();
    } catch (error) {
      if (this.stopped) return;
      if (error instanceof RateLimitedError) {
        this.log.error(`${state.name}: command rejected, the Onecta daily rate limit is reached. The Matter state will resync on the next poll.`);
        this.schedulePoll((error.retryAfter ?? 3600) * 1000);
      } else {
        this.log.error(`${state.name}: sending command failed: ${error instanceof Error ? error.message : String(error)}. Resyncing in ${RESYNC_DELAY_MS / 1000}s.`);
        this.schedulePoll(RESYNC_DELAY_MS);
      }
    }
  }

  /**
   * Map the Onecta on/off + operation mode to a Matter thermostat system mode.
   *
   * @param {ClimateState} state - The parsed climate state.
   * @returns {Thermostat.SystemMode} The Matter system mode.
   */
  private systemModeFor(state: ClimateState): Thermostat.SystemMode {
    if (!state.onOff) return Thermostat.SystemMode.Off;
    switch (state.operationMode) {
      case 'heating':
        return Thermostat.SystemMode.Heat;
      case 'cooling':
        return Thermostat.SystemMode.Cool;
      case 'dry':
        return Thermostat.SystemMode.Dry;
      case 'fanOnly':
        return Thermostat.SystemMode.FanOnly;
      default:
        return Thermostat.SystemMode.Auto;
    }
  }

  /**
   * Map the Onecta fan state to a Matter fan mode.
   *
   * @param {ClimateState} state - The parsed climate state.
   * @returns {FanControl.FanMode} The Matter fan mode.
   */
  private fanModeFor(state: ClimateState): FanControl.FanMode {
    if (!state.onOff) return FanControl.FanMode.Off;
    if (state.fan?.mode === 'auto') return FanControl.FanMode.Auto;
    if (state.fan?.mode === 'quiet') return FanControl.FanMode.Low;
    const ratio = (state.fan?.speed ?? 1) / (state.fan?.maxSpeed ?? 5);
    if (ratio <= 0.34) return FanControl.FanMode.Low;
    if (ratio <= 0.67) return FanControl.FanMode.Medium;
    return FanControl.FanMode.High;
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
