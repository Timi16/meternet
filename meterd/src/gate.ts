// What meterd opens and closes per device. On the hotspot box this is
// openNDS (`ndsctl auth` / `ndsctl deauth`); on the public web MVP it is the
// metered HTTP gateway.
export interface Gate {
  open(deviceKey: string): Promise<void>;
  close(deviceKey: string): Promise<void>;
}
