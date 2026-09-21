package panel

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// TestSameOriginWriteParity：同源写校验对齐 Node requireSameOriginWrite。
func TestSameOriginWriteParity(t *testing.T) {
	makeRequest := func(method, path, host, origin, referer string) *http.Request {
		request := httptest.NewRequest(method, path, nil)
		request.Host = host
		if origin != "" {
			request.Header.Set("Origin", origin)
		}
		if referer != "" {
			request.Header.Set("Referer", referer)
		}
		return request
	}

	// 读方法不受影响。
	if isWriteMethod(http.MethodGet) || isWriteMethod(http.MethodHead) {
		t.Fatal("GET/HEAD 不应视为写方法")
	}
	for _, method := range []string{http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete} {
		if !isWriteMethod(method) {
			t.Fatalf("%s 应视为写方法", method)
		}
	}

	// 缺失来源放行。
	if !isAllowedPanelOrigin(makeRequest(http.MethodPost, "/api/config", "panel:8080", "", ""), "") {
		t.Fatal("缺失来源应放行")
	}
	// 同源放行（含 127.0.0.1/localhost 别名；显式端口相等时 https origin 亦放行，与 Node 一致）。
	for _, origin := range []string{"http://panel:8080", "https://panel:8080", "http://127.0.0.1:8080", "http://localhost:8080"} {
		if !isAllowedPanelOrigin(makeRequest(http.MethodPost, "/api/config", "panel:8080", origin, ""), origin) {
			t.Fatalf("同源 %s 应放行", origin)
		}
	}

	// IPv6 与反向代理放行
	if !isAllowedPanelOrigin(makeRequest(http.MethodPost, "/api/config", "[::1]:8080", "http://[::1]:8080", ""), "http://[::1]:8080") {
		t.Fatal("IPv6 [::1]:8080 应放行")
	}
	fwdReq := makeRequest(http.MethodPost, "/api/config", "127.0.0.1:8080", "https://panel.example.com", "")
	fwdReq.Header.Set("X-Forwarded-Host", "panel.example.com")
	fwdReq.Header.Set("X-Forwarded-Proto", "https")
	if !isAllowedPanelOrigin(fwdReq, "https://panel.example.com") {
		t.Fatal("反代 X-Forwarded-Host 应放行")
	}
	if !isAllowedPanelOrigin(makeRequest(http.MethodPost, "/api/config", "MY-PC:8080", "http://my-pc:8080", ""), "http://my-pc:8080") {
		t.Fatal("大小写机器名应放行")
	}
	// 跨主机/跨端口/非法来源拒绝（Node 只要求 origin 协议 http/https 且端口相等）。
	for _, origin := range []string{"http://evil.com", "http://panel:9999", "https://panel:9999", "not-a-url"} {
		if isAllowedPanelOrigin(makeRequest(http.MethodPost, "/api/config", "panel:8080", origin, ""), origin) {
			t.Fatalf("跨源 %s 应拒绝", origin)
		}
	}
	// Referer 跨源同样拒绝。
	if isAllowedPanelOrigin(makeRequest(http.MethodPost, "/api/config", "panel:8080", "", "http://evil.com/x"), "http://evil.com") {
		t.Fatal("跨源 Referer 应拒绝")
	}

	// 全链路：跨源写请求 403 且包络与 Node 一致。
	server, _ := newTestServer(t)
	handler := server.middleware(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writeJSON(writer, http.StatusOK, map[string]any{"success": true})
	}))
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, makeRequest(http.MethodPost, "/api/config", "panel:8080", "http://evil.com", ""))
	if recorder.Code != http.StatusForbidden {
		t.Fatalf("跨源写应 403，实际 %d", recorder.Code)
	}
	if body := recorder.Body.String(); !strings.Contains(body, "跨源写入请求已被拒绝") {
		t.Fatalf("403 包络不符：%s", body)
	}
	// 同源写放行。
	recorder = httptest.NewRecorder()
	handler.ServeHTTP(recorder, makeRequest(http.MethodPost, "/api/config", "panel:8080", "http://panel:8080", ""))
	if recorder.Code != http.StatusOK {
		t.Fatalf("同源写应放行，实际 %d", recorder.Code)
	}
}
