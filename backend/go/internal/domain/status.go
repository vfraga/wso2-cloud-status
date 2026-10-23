// Copyright (c) 2026, WSO2 LLC. (https://www.wso2.com).
//
// WSO2 LLC. licenses this file to you under the Apache License,
// Version 2.0 (the "License"); you may not use this file except
// in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing,
// software distributed under the License is distributed on an
// "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
// KIND, either express or implied. See the License for the
// specific language governing permissions and limitations
// under the License.

// Package domain holds the customer-facing status model and the rules that
// roll component statuses up to regions, products and the whole cloud.
package domain

import (
	"fmt"
)

// Status is the customer-facing state of a component, region, product or day.
//
// The zero value is StatusUnknown so that a value nobody set never reads as
// healthy.
type Status int

// Statuses, in the order of the severity they communicate. StatusUnknown has
// no severity: it means "we cannot vouch for this", not "this is broken".
const (
	StatusUnknown Status = iota
	StatusOperational
	StatusMaintenance
	StatusDegraded
	StatusOutage
)

// Statuses lists every status: unknown, then the others by severity.
func Statuses() []Status {
	return []Status{StatusUnknown, StatusOperational, StatusMaintenance, StatusDegraded, StatusOutage}
}

var statusNames = map[Status]string{
	StatusUnknown:     "unknown",
	StatusOperational: "operational",
	StatusMaintenance: "maintenance",
	StatusDegraded:    "degraded",
	StatusOutage:      "outage",
}

// String returns the wire name of the status.
func (s Status) String() string {
	if name, ok := statusNames[s]; ok {
		return name
	}
	return statusNames[StatusUnknown]
}

// MarshalText encodes the status as its wire name.
func (s Status) MarshalText() ([]byte, error) {
	return []byte(s.String()), nil
}

// UnmarshalText decodes a wire name. Unrecognised names are an error so that
// a typo in a fixture or a contract change fails loudly.
func (s *Status) UnmarshalText(text []byte) error {
	for status, name := range statusNames {
		if name == string(text) {
			*s = status
			return nil
		}
	}
	return fmt.Errorf("domain: unknown status %q", text)
}

// Known reports whether the status carries information.
func (s Status) Known() bool {
	return s != StatusUnknown
}

// Worst rolls statuses up to the most severe known one.
//
// Unknown inputs are skipped so that one source we failed to read does not
// grey out everything around it; callers flag partial data separately. The
// result is StatusUnknown only when every input is unknown, or there are none.
func Worst(statuses ...Status) Status {
	worst := StatusUnknown
	for _, s := range statuses {
		if s.Known() && s > worst {
			worst = s
		}
	}
	return worst
}
