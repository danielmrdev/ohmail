export declare function invalidDbReading(input: {
  rows: { datname: string; datconnlimit: number | string }[];
  doorOf: (name: string) => string;
}): { rc: number; invalid: string[]; lines: string[] };
