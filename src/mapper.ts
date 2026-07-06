/**
 * Maps raw Onecta gateway-device descriptions to typed climate state.
 * Pure functions, no Matter or network dependencies: testable against fixtures.
 *
 * @file mapper.ts
 * @author Mehmet Celik
 * @license Apache-2.0
 */

export type OnectaOperationMode = 'heating' | 'cooling' | 'auto' | 'dry' | 'fanOnly';

export interface SetpointRange {
  /** Target temperature in °C. */
  value: number;
  min: number;
  max: number;
  step: number;
}

export interface FanState {
  /** Current fan speed mode for the active operation mode. */
  mode: 'auto' | 'quiet' | 'fixed';
  /** Speed when mode is "fixed". */
  speed?: number;
  maxSpeed?: number;
}

export interface ClimateState {
  gatewayId: string;
  embeddedId: string;
  /** User-visible unit name from the Onecta app, e.g. the room name. */
  name: string;
  connected: boolean;
  onOff: boolean;
  operationMode: OnectaOperationMode;
  supportedModes: OnectaOperationMode[];
  /** °C from sensoryData. */
  roomTemperature?: number;
  /** °C from sensoryData. */
  outdoorTemperature?: number;
  heatingSetpoint?: SetpointRange;
  coolingSetpoint?: SetpointRange;
  autoSetpoint?: SetpointRange;
  fan?: FanState;
}

const isRecord = (data: unknown): data is Record<string, unknown> => data !== null && typeof data === 'object';

const valueOf = (data: unknown): unknown => (isRecord(data) ? data.value : undefined);

const numberOf = (data: unknown): number | undefined => {
  const raw = valueOf(data);
  return typeof raw === 'number' ? raw : undefined;
};

const stringOf = (data: unknown): string | undefined => {
  const raw = valueOf(data);
  return typeof raw === 'string' ? raw : undefined;
};

const setpointRange = (data: unknown): SetpointRange | undefined => {
  if (!isRecord(data)) return undefined;
  const { value, minValue, maxValue, stepValue } = data;
  if (typeof value !== 'number') return undefined;
  return {
    value,
    min: typeof minValue === 'number' ? minValue : value,
    max: typeof maxValue === 'number' ? maxValue : value,
    step: typeof stepValue === 'number' ? stepValue : 0.5,
  };
};

/**
 * Extract the roomTemperature setpoint of one operation mode from temperatureControl.
 *
 * @param {unknown} temperatureControl - The raw temperatureControl characteristic.
 * @param {string} mode - The operation mode name.
 * @returns {SetpointRange | undefined} The setpoint range, when present.
 */
const modeSetpoint = (temperatureControl: unknown, mode: string): SetpointRange | undefined => {
  const control = valueOf(temperatureControl);
  if (!isRecord(control) || !isRecord(control.operationModes)) return undefined;
  const operationMode = control.operationModes[mode];
  if (!isRecord(operationMode) || !isRecord(operationMode.setpoints)) return undefined;
  return setpointRange(operationMode.setpoints.roomTemperature);
};

/**
 * Extract the fan speed state of the active operation mode from fanControl.
 *
 * @param {unknown} fanControl - The raw fanControl characteristic.
 * @param {string} mode - The operation mode name.
 * @returns {FanState | undefined} The fan state, when present.
 */
const modeFan = (fanControl: unknown, mode: string): FanState | undefined => {
  const control = valueOf(fanControl);
  if (!isRecord(control) || !isRecord(control.operationModes)) return undefined;
  const operationMode = control.operationModes[mode];
  if (!isRecord(operationMode) || !isRecord(operationMode.fanSpeed)) return undefined;
  const fanSpeed = operationMode.fanSpeed;
  const currentMode = valueOf(fanSpeed.currentMode);
  if (currentMode !== 'auto' && currentMode !== 'quiet' && currentMode !== 'fixed') return undefined;
  const fan: FanState = { mode: currentMode };
  if (isRecord(fanSpeed.modes)) {
    const fixed = fanSpeed.modes.fixed;
    fan.speed = numberOf(fixed);
    if (isRecord(fixed) && typeof fixed.maxValue === 'number') fan.maxSpeed = fixed.maxValue;
  }
  return fan;
};

const OPERATION_MODES: OnectaOperationMode[] = ['heating', 'cooling', 'auto', 'dry', 'fanOnly'];

/**
 * Parse all climateControl management points of one gateway device description.
 *
 * @param {Record<string, unknown>} desc - The raw device description from GET /v1/gateway-devices.
 * @returns {ClimateState[]} One state per climateControl management point (usually one).
 */
export function parseClimateStates(desc: Record<string, unknown>): ClimateState[] {
  const states: ClimateState[] = [];
  const gatewayId = typeof desc.id === 'string' ? desc.id : '';
  const connected = valueOf(desc.isCloudConnectionUp) === true;
  const managementPoints = Array.isArray(desc.managementPoints) ? desc.managementPoints.filter(isRecord) : [];
  for (const point of managementPoints) {
    if (point.managementPointType !== 'climateControl') continue;
    const operationModeData = point.operationMode;
    const rawMode = valueOf(operationModeData);
    const operationMode = OPERATION_MODES.find((mode) => mode === rawMode) ?? 'auto';
    const supported = isRecord(operationModeData) && Array.isArray(operationModeData.values) ? operationModeData.values : [];
    const sensoryData = valueOf(point.sensoryData);
    const state: ClimateState = {
      gatewayId,
      embeddedId: typeof point.embeddedId === 'string' ? point.embeddedId : 'climateControl',
      name: stringOf(point.name) ?? gatewayId,
      connected,
      onOff: valueOf(point.onOffMode) === 'on',
      operationMode,
      supportedModes: OPERATION_MODES.filter((mode) => supported.includes(mode)),
      heatingSetpoint: modeSetpoint(point.temperatureControl, 'heating'),
      coolingSetpoint: modeSetpoint(point.temperatureControl, 'cooling'),
      autoSetpoint: modeSetpoint(point.temperatureControl, 'auto'),
      fan: modeFan(point.fanControl, operationMode),
    };
    if (isRecord(sensoryData)) {
      state.roomTemperature = numberOf(sensoryData.roomTemperature);
      state.outdoorTemperature = numberOf(sensoryData.outdoorTemperature);
    }
    states.push(state);
  }
  return states;
}

/**
 * Stable, Matter-compliant (max 32 chars) serial for an endpoint derived from a device.
 *
 * @param {string} gatewayId - The gateway device UUID.
 * @param {string} suffix - Short role suffix, e.g. "CC", "OT", "FAN".
 * @returns {string} The serial string.
 */
export function endpointSerial(gatewayId: string, suffix: string): string {
  return `${gatewayId.replaceAll('-', '').slice(0, 24)}-${suffix}`.slice(0, 32);
}

/**
 * Convert °C to the centi-degrees used by Matter temperature attributes.
 *
 * @param {number} celsius - Temperature in °C.
 * @returns {number} Temperature in centi-degrees.
 */
export const toMatterTemperature = (celsius: number): number => Math.round(celsius * 100);

/**
 * Convert a fixed fan speed (1..maxSpeed) to a Matter fan percentage (1..100).
 *
 * @param {number} speed - The fixed speed step.
 * @param {number} maxSpeed - The maximum speed step.
 * @returns {number} The percentage (1..100).
 */
export const toFanPercent = (speed: number, maxSpeed: number): number => Math.max(1, Math.min(100, Math.round((speed / Math.max(1, maxSpeed)) * 100)));
