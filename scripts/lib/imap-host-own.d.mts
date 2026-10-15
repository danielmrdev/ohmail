/** Declarations for `imap-host-own.mjs`, so the census that reads it can be typechecked. */
export declare function code(src: string): string;
export declare const OPENS_IMAP: RegExp;
export declare const DERIVES_IMAP_HOST: RegExp[];
export declare const HOST_OWNERS: ReadonlySet<string>;
export declare const GREENMAIL_EDGES: RegExp[];
export declare function opensImapClient(src: string): boolean;
export declare function derivesOwnHost(src: string): boolean;
export declare function ownsItsImapHost(rel: string, src: string): boolean;
export declare function isGreenmailEdge(spec: string): boolean;
