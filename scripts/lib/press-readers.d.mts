export interface PressReaderSite {
  line: number;
  superseded: boolean;
  viaVerdict: boolean;
}
export function pressReaderSites(src: string): PressReaderSite[];
