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

import { ErrorBoundary } from "./components/ErrorBoundary";
import { Layout } from "./components/Layout";
import { matchRoute, usePathname } from "./lib/router";
import { HomePage } from "./pages/HomePage";
import { NotFoundPage } from "./pages/NotFoundPage";
import { ProductPage } from "./pages/ProductPage";
import { ThemeRoot } from "./theme/ThemeRoot";

function Routes() {
  const route = matchRoute(usePathname());
  switch (route.name) {
    case "home":
      return <HomePage />;
    case "product":
      return <ProductPage key={route.id} id={route.id} />;
    default:
      return <NotFoundPage />;
  }
}

export function App() {
  return (
    <ErrorBoundary>
      <ThemeRoot>
        <Layout>
          <Routes />
        </Layout>
      </ThemeRoot>
    </ErrorBoundary>
  );
}
