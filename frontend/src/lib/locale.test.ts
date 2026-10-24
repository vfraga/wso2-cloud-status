/**
 * Copyright (c) 2026, WSO2 LLC. (https://www.wso2.com).
 *
 * WSO2 LLC. licenses this file to you under the Apache License,
 * Version 2.0 (the "License"); you may not use this file except
 * in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { describe, expect, it } from "vitest";
import { formatClock, formatDayHeading, formatUtcClock } from "./time";

/*
 * Times are shown in the reader's locale (an owner decision). `npm test` runs
 * this file once more with VITEST_LOCALE=de and a German locale; a format
 * pinned to one locale then fails here. In every other run it is skipped.
 */
describe.runIf(process.env.VITEST_LOCALE === "de")("times in a German locale", () => {
  const at = new Date("2026-10-21T14:05:00Z");

  it("runs in German", () => {
    expect(Intl.DateTimeFormat().resolvedOptions().locale).toMatch(/^de\b/);
  });

  it("writes a 24-hour clock and German dates", () => {
    expect(formatUtcClock(at)).toBe("14:05 UTC");
    // The suite pins the zone to UTC.
    expect(formatClock(at)).toBe("14:05 UTC");
    expect(formatDayHeading(new Date(2026, 9, 21))).toBe("21. Oktober 2026");
  });
});
