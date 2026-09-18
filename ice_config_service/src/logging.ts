export function logIceAccess(params: {
  event: 'ice_servers';
  status: 'ok' | 'error';
  httpStatus: number;
  serverId?: string;
  keyId?: string;
  vpsId?: string | null;
  familyId?: string | null;
  circleSubjectId?: string | null;
  mediaSessionId?: string | null;
  purpose?: string | null;
  turnClusterId?: string | null;
  iceServerCount?: number;
  error?: string;
  durationMs: number;
}): void {
  const line = {
    ts: new Date().toISOString(),
    service: 'ice-config-service',
    ...params
  };
  const serialized = JSON.stringify(line);
  if (params.status === 'ok') {
    console.log(serialized);
  } else {
    console.warn(serialized);
  }
}
