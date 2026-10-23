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

// Package contract holds black-box tests that any implementation of
// api/openapi.yaml must pass. Point BASE_URL at a running backend.
package contract

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"

	"github.com/santhosh-tekuri/jsonschema/v6"
	"go.yaml.in/yaml/v3"
)

// Schemas compiles component schemas from the OpenAPI document, which is
// JSON Schema 2020-12 compatible (OpenAPI 3.1).
type Schemas struct {
	compiler *jsonschema.Compiler
}

const docURL = "file:///openapi.json"

// LoadSchemas reads the OpenAPI document at path.
func LoadSchemas(path string) (*Schemas, error) {
	raw, err := os.ReadFile(path) //nolint:gosec // Fixed path from the test.
	if err != nil {
		return nil, err
	}
	var doc any
	if err := yaml.Unmarshal(raw, &doc); err != nil {
		return nil, fmt.Errorf("contract: parse %s: %w", path, err)
	}
	asJSON, err := json.Marshal(doc)
	if err != nil {
		return nil, err
	}
	parsed, err := jsonschema.UnmarshalJSON(bytes.NewReader(asJSON))
	if err != nil {
		return nil, err
	}
	c := jsonschema.NewCompiler()
	c.DefaultDraft(jsonschema.Draft2020)
	c.AssertFormat()
	if err := c.AddResource(docURL, parsed); err != nil {
		return nil, err
	}
	return &Schemas{compiler: c}, nil
}

// Validate checks a JSON body against components/schemas/<name>.
func (s *Schemas) Validate(name string, body []byte) error {
	sch, err := s.compiler.Compile(docURL + "#/components/schemas/" + name)
	if err != nil {
		return fmt.Errorf("contract: compile %s: %w", name, err)
	}
	v, err := jsonschema.UnmarshalJSON(bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("contract: body is not JSON: %w", err)
	}
	return sch.Validate(v)
}
