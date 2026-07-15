import { assertEquals } from "jsr:@std/assert@1";
import { extractHash } from "./cli.ts";

Deno.test("extractHash: enriched_ プレフィックスから HASH を抽出する", () => {
  assertEquals(extractHash("enriched_receiveagent_RECE77C1.json"), "RECE77C1");
});

Deno.test("extractHash: watch-enrich_（rolling baseline）でも同じ識別子になる", () => {
  assertEquals(extractHash("watch-enrich_receiveagent_RECE77C1.json"), "RECE77C1");
  assertEquals(extractHash("watch-enrich_scan-target_SCAN29FD.json"), "SCAN29FD");
});

Deno.test("extractHash: 日時サフィックス付きでも先頭8文字（HASH）を返す", () => {
  assertEquals(extractHash("enriched_myapp_MYAP7C1A26061217.json"), "MYAP7C1A");
});
