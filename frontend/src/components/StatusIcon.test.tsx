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

import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { wrap } from "../test/render";
import { ProductListSkeleton } from "./Skeletons";
import { StatusLabel } from "./StatusIcon";

describe("StatusLabel", () => {
  it("renders a status as icon plus text and a loading skeleton", () => {
    wrap(
      <>
        <StatusLabel status="maintenance">Under maintenance</StatusLabel>
        <ProductListSkeleton />
      </>,
    );
    expect(screen.getByText("Under maintenance")).toBeInTheDocument();
    expect(document.querySelector('[aria-busy="true"]')).toBeInTheDocument();
  });
});
