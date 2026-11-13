/**
 * Secrets live only in Windows Credential Manager (ADR-007), service "Jarvis".
 * Never in the DB, config files, logs or persisted environment variables.
 */
import { Entry } from "@napi-rs/keyring";

export const SECRET_SERVICE = "Jarvis";

export type SecretName = "anthropic-api-key" | "google-tts-api-key";

export interface SecretStore {
  get(name: SecretName): string | undefined;
  set(name: SecretName, value: string): void;
  delete(name: SecretName): boolean;
}

export class KeyringSecretStore implements SecretStore {
  constructor(private readonly service: string = SECRET_SERVICE) {}

  get(name: SecretName): string | undefined {
    return new Entry(this.service, name).getPassword() ?? undefined;
  }

  set(name: SecretName, value: string): void {
    const trimmed = value.trim();
    if (!trimmed) throw new Error("refusing to store an empty secret");
    new Entry(this.service, name).setPassword(trimmed);
  }

  delete(name: SecretName): boolean {
    return new Entry(this.service, name).deletePassword();
  }
}

/** In-memory store for tests and for dev runs that must not touch the real vault. */
export class MemorySecretStore implements SecretStore {
  private readonly values = new Map<SecretName, string>();
  get(name: SecretName) {
    return this.values.get(name);
  }
  set(name: SecretName, value: string) {
    this.values.set(name, value);
  }
  delete(name: SecretName) {
    return this.values.delete(name);
  }
}
