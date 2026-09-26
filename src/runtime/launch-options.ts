import { isAbsolute } from "node:path";

export interface LaunchOptions {
  readonly configPath?: string;
  readonly desktop: boolean;
  readonly smokeTest: boolean;
  readonly smokeDataDirectory?: string;
}

export function parseLaunchOptions(args: readonly string[]): LaunchOptions {
  let configPath: string | undefined;
  let desktop = false;
  let smokeTest = false;
  let smokeDataDirectory: string | undefined;
  const seen = new Set<string>();

  const once = (option: string): void => {
    if (seen.has(option)) throw new Error(`Duplicate argument: ${option}`);
    seen.add(option);
  };

  for (let index = 0; index < args.length; index += 1) {
    const option = args[index]!;
    once(option);
    switch (option) {
      case "--config": {
        const value = args[index + 1];
        if (value === undefined || value.startsWith("--")) {
          throw new Error("Missing value for --config");
        }
        if (!isAbsolute(value)) throw new Error("--config must be an absolute path");
        configPath = value;
        index += 1;
        break;
      }
      case "--desktop":
        desktop = true;
        break;
      case "--smoke-test":
        smokeTest = true;
        break;
      case "--data-dir": {
        const value = args[index + 1];
        if (value === undefined || value.startsWith("--")) {
          throw new Error("Missing value for --data-dir");
        }
        if (!isAbsolute(value)) throw new Error("--data-dir must be an absolute path");
        smokeDataDirectory = value;
        index += 1;
        break;
      }
      default:
        throw new Error(`Unknown argument: ${option}`);
    }
  }

  return {
    ...(configPath === undefined ? {} : { configPath }),
    desktop,
    smokeTest,
    ...(smokeDataDirectory === undefined ? {} : { smokeDataDirectory }),
  };
}
