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

import { Component, type ErrorInfo, type ReactElement, type ReactNode } from "react";
import { config } from "../config";
import { pageTitle } from "../hooks/useDocumentTitle";
import { RENDER_FAILED, RENDER_FAILED_DETAIL } from "../lib/status";

interface State {
  failed: boolean;
}

/**
 * Last resort: a plain message instead of a blank page. The title says so
 * too, since nothing polls meanwhile and the last status would stay in the
 * tab. After one summary interval it
 * renders the page again, which polls again, so a tab left open recovers
 * once the data does.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { failed: false };
  private retry: ReturnType<typeof setTimeout> | undefined;

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("Status page rendering failed", error, info.componentStack);
    document.title = pageTitle(RENDER_FAILED);
    clearTimeout(this.retry);
    this.retry = setTimeout(() => {
      this.setState({ failed: false });
    }, config.summaryIntervalMs);
  }

  override componentWillUnmount(): void {
    clearTimeout(this.retry);
  }

  override render(): ReactElement {
    if (!this.state.failed) return <>{this.props.children}</>;
    return (
      <div
        role="alert"
        style={{ maxWidth: 560, margin: "15vh auto", padding: 16, fontFamily: "sans-serif" }}
      >
        <h1 style={{ fontSize: "1.25rem" }}>{RENDER_FAILED}</h1>
        <p>{RENDER_FAILED_DETAIL}</p>
      </div>
    );
  }
}
