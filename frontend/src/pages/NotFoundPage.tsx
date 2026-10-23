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

import { Typography } from "@wso2/oxygen-ui";
import { pageTitle, useDocumentTitle } from "../hooks/useDocumentTitle";
import { useViewHeading } from "../hooks/useViewFocus";
import { Link } from "../lib/router";

export function NotFoundPage({ what = "page" }: { what?: string }) {
  useDocumentTitle(pageTitle("Not found"));
  // Replaces a product page whose data said the product does not exist.
  const heading = useViewHeading<HTMLHeadingElement>(true);
  return (
    <section aria-labelledby="not-found" style={{ paddingTop: 24 }}>
      <Typography
        id="not-found"
        component="h1"
        ref={heading}
        tabIndex={-1}
        sx={{ fontSize: "1.5rem", fontWeight: 600 }}
      >
        {`We could not find that ${what}`}
      </Typography>
      <Typography sx={{ mt: 1 }}>
        <Link to="/">See the status of all products</Link>
      </Typography>
    </section>
  );
}
