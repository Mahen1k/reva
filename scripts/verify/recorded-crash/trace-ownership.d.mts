export interface OwnershipTrace {
  readonly pid: number;
  readonly file: string;
  readonly text: string;
}

export interface OwnershipTraceOptions {
  readonly sentinelPid: number;
  readonly psPaths: ReadonlySet<string>;
  readonly identityExecutable: string;
  readonly identityHelper: string;
}

export function traceExecution(line: string):
  | {
      readonly executable: string;
      readonly arguments: readonly string[];
      readonly successful: boolean;
    }
  | undefined;

export function verifyHistoricalPidReads(
  traces: readonly OwnershipTrace[],
  options: OwnershipTraceOptions,
): readonly {
  readonly actor: number;
  readonly observer: "process-table" | "native-identities";
  readonly syscall: string;
}[];
