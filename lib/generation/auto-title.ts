import { randomInt } from "node:crypto";

/**
 * The name of a prompt nobody named: a Quick Create render, an editor test
 * render (Kev, 2026-10-17: every prompt has a title; one made on the side is
 * "enki-" and a unique id). Eight base36 characters, 2.8 trillion ids: among a
 * million of them a repeat is about a one-in-five chance, and nothing of the
 * prompt's encrypted body reaches the title.
 */
export function autoTitle(): string {
  return `enki-${randomInt(36 ** 8).toString(36).padStart(8, "0")}`;
}
