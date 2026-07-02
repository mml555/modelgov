import { describe, expect, it } from "vitest";
import { expandFileSecrets } from "../src/config/secrets";

describe("expandFileSecrets", () => {
  const fakeReader = (path: string): string => {
    const files: Record<string, string> = {
      "/run/secrets/db": "postgres://u:p@host/db\n",
      "/run/secrets/key": "  sk-secret  ",
    };
    const v = files[path];
    if (v === undefined) throw new Error("ENOENT");
    return v;
  };

  it("reads a *_FILE secret into its base var and trims it", () => {
    const out = expandFileSecrets({ DATABASE_URL_FILE: "/run/secrets/db" }, fakeReader);
    expect(out.DATABASE_URL).toBe("postgres://u:p@host/db");
  });

  it("does not clobber an explicitly-set base var", () => {
    const out = expandFileSecrets(
      { AI_GUARD_API_KEY: "explicit", AI_GUARD_API_KEY_FILE: "/run/secrets/key" },
      fakeReader,
    );
    expect(out.AI_GUARD_API_KEY).toBe("explicit");
  });

  it("overrides an empty base var with the file value", () => {
    const out = expandFileSecrets(
      { AI_GUARD_API_KEY: "", AI_GUARD_API_KEY_FILE: "/run/secrets/key" },
      fakeReader,
    );
    expect(out.AI_GUARD_API_KEY).toBe("sk-secret");
  });

  it("throws a clear error when a declared secret file is unreadable", () => {
    expect(() => expandFileSecrets({ FOO_FILE: "/nope" }, fakeReader)).toThrow(/failed to read secret file for FOO/);
  });

  it("leaves env without *_FILE keys untouched", () => {
    const out = expandFileSecrets({ PORT: "3000" }, fakeReader);
    expect(out).toEqual({ PORT: "3000" });
  });
});
