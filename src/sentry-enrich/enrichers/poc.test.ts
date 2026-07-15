import { assertEquals } from "jsr:@std/assert@1";
import { maxConfidence } from "./poc.ts";

Deno.test("maxConfidence: 既存の high は medium で降格しない", () => {
  assertEquals(maxConfidence("high", "medium"), "high");
});

Deno.test("maxConfidence: 既存が low なら medium へ昇格する", () => {
  assertEquals(maxConfidence("low", "medium"), "medium");
});

Deno.test("maxConfidence: 同値はそのまま", () => {
  assertEquals(maxConfidence("medium", "medium"), "medium");
});
