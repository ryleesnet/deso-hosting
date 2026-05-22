declare module "@novnc/novnc/lib/rfb" {
  export default class RFB {
    constructor(
      target: HTMLElement,
      url: string,
      options?: { credentials?: { password?: string } }
    );
    scaleViewport: boolean;
    resizeSession: boolean;
    addEventListener(
      event: "connect" | "disconnect",
      handler: () => void
    ): void;
    disconnect(): void;
  }
}

declare module "novnc-next" {
  export default class RFB {
    constructor(
      target: HTMLElement,
      url: string,
      options?: { credentials?: { password?: string } }
    );
    scaleViewport: boolean;
    resizeSession: boolean;
    addEventListener(
      event:
        | "connect"
        | "disconnect"
        | "securityfailure"
        | "serververification",
      handler: (...args: unknown[]) => void
    ): void;
    approveServer(): void;
    disconnect(): void;
  }
}
