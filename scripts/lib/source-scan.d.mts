export declare function withoutComments(src: string): string;
export declare function withoutCommentsAndLiterals(src: string): string;
export declare function withoutHashComments(src: string): string;
export declare function bracketSpan(
  src: string, open: number, o?: string, c?: string,
): { start: number; end: number; closed: boolean };
export declare function span(src: string, open: number, o?: string, c?: string): [number, number];
export declare function lineOf(src: string, at: number): number;
