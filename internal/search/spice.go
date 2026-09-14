package search

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Spice 即时数据（对齐 Node src/search/spice.js）：
// - forecast 返回 Apple WeatherKit 结构（currentWeather / forecastDaily.days）
// - currency 返回 xe.com 中间价结构

const spiceBase = "https://duckduckgo.com/js/spice"

var spiceWrapperRE = regexp.MustCompile(`(?s)^ddg_spice_[\w]+\(\n?([\s\S]+?)\n?\);?\s*$`)
var spiceEmptyRE = regexp.MustCompile(`^ddg_spice_\w+\(\s*\)`)

// conditionZH 是天气代码到中文的映射。
var conditionZH = map[string]string{
	"Clear": "晴", "MostlyClear": "晴间多云", "PartlyCloudy": "多云", "MostlyCloudy": "多云转阴",
	"Cloudy": "阴", "Fog": "雾", "Haze": "霾", "Smoke": "烟霾", "Breezy": "微风", "Windy": "大风",
	"Drizzle": "毛毛雨", "FreezingDrizzle": "冻毛毛雨", "Rain": "雨", "HeavyRain": "大雨",
	"FreezingRain": "冻雨", "MixedRainAndSleet": "雨夹雪", "MixedRainAndSnow": "雨夹雪",
	"MixedSnowAndSleet": "雪夹雨", "ScatteredShowers": "零星阵雨", "ScatteredThunderstorms": "零星雷阵雨",
	"Thunderstorms": "雷阵雨", "IsolatedThunderstorms": "局部雷阵雨", "StrongStorms": "强雷暴",
	"Snow": "雪", "Flurries": "阵雪", "HeavySnow": "大雪", "Blizzard": "暴雪", "BlowingSnow": "吹雪",
	"WintryMix": "冬季混合降水", "Hail": "冰雹", "Sleet": "雨夹雪", "TropicalStorm": "热带风暴",
	"Hurricane": "飓风", "Hot": "炎热", "Cold": "寒冷", "Frigid": "严寒", "Freezing": "冰冻",
}

func describeCondition(code string) string {
	key := strings.TrimSpace(code)
	if translated, ok := conditionZH[key]; ok && key != "" {
		return translated
	}
	if key == "" {
		return "未知"
	}
	return key
}

func formatNumber(value float64, digits int) string {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return "—"
	}
	return strconv.FormatFloat(value, 'f', digits, 64)
}

func formatPercent(raw any) string {
	value, ok := raw.(float64)
	if !ok {
		return "—"
	}
	percent := value
	if value <= 1 {
		percent = value * 100
	}
	return strconv.Itoa(int(math.Round(percent))) + "%"
}

func formatDateLabel(raw any) string {
	text, _ := raw.(string)
	if text == "" {
		return ""
	}
	parsed, err := time.Parse(time.RFC3339, text)
	if err != nil {
		if parsed, err = time.Parse("2006-01-02", text); err != nil {
			return text
		}
	}
	return fmt.Sprintf("%d/%d", int(parsed.Month()), parsed.Day())
}

// fetchSpice 请求并解析 ddg_spice_* 包装的 JSON。
func (s *Service) fetchSpice(ctx context.Context, path string, timeoutMs int) (map[string]any, error) {
	response, err := s.client.RequestText(ctx, spiceBase+"/"+path, requestOptions{
		Headers: map[string]string{"Accept": "application/json,text/javascript,*/*"},
		Timeout: time.Duration(timeoutMs) * time.Millisecond,
	})
	if err != nil {
		return nil, fmt.Errorf("DuckDuckGo spice 请求失败: %w", err)
	}
	if !response.OK {
		return nil, fmt.Errorf("DuckDuckGo spice 返回 HTTP %d", response.Status)
	}
	text := strings.TrimSpace(response.Body)
	if spiceEmptyRE.MatchString(text) {
		return nil, nil
	}
	match := spiceWrapperRE.FindStringSubmatch(text)
	if match == nil {
		return nil, fmt.Errorf("DuckDuckGo spice 响应格式无法解析")
	}
	var decoded map[string]any
	if err := json.Unmarshal([]byte(match[1]), &decoded); err != nil {
		return nil, fmt.Errorf("DuckDuckGo spice 响应不是合法 JSON")
	}
	return decoded, nil
}

// FetchWeather 查询指定地点的天气（对齐 Node fetchWeather）。
func (s *Service) FetchWeather(ctx context.Context, location string, days int, locale string, timeoutMs int) (map[string]any, error) {
	query := strings.TrimSpace(location)
	if query == "" {
		return nil, fmt.Errorf("地点不能为空")
	}
	payload, err := s.fetchSpice(ctx, "forecast/"+urlEncode(query)+"/"+urlEncode(orStr(locale, "zh-cn")), timeoutMs)
	if err != nil {
		return nil, err
	}
	if payload == nil {
		return map[string]any{"ok": false, "location": query, "error": fmt.Sprintf("未找到「%s」的天气数据，请换一个更明确的地点名称", query)}, nil
	}
	current, _ := payload["currentWeather"].(map[string]any)
	forecastDaily, _ := payload["forecastDaily"].(map[string]any)
	allDays, _ := forecastDaily["days"].([]any)
	if days < 1 {
		days = 3
	}
	if days > 7 {
		days = 7
	}
	daily := []map[string]any{}
	for index, dayRaw := range allDays {
		if index >= days {
			break
		}
		day, _ := dayRaw.(map[string]any)
		if day == nil {
			continue
		}
		daytimeForecast, _ := day["daytimeForecast"].(map[string]any)
		precipChance := day["precipitationChance"]
		if daytimeForecast != nil {
			if chance, ok := daytimeForecast["precipitationChance"]; ok {
				precipChance = chance
			}
		}
		daily = append(daily, map[string]any{
			"date":                       orStr(stringOf(day["forecastStart"]), orStr(stringOf(day["date"]), "")),
			"condition":                  describeCondition(stringOf(day["conditionCode"])),
			"conditionCode":              stringOf(day["conditionCode"]),
			"temperatureMax":             floatOf(day["temperatureMax"]),
			"temperatureMin":             floatOf(day["temperatureMin"]),
			"precipitationChancePercent": formatPercent(precipChance),
		})
	}
	locationName := query
	if locationMap, ok := payload["location"].(map[string]any); ok {
		if name := stringOf(locationMap["name"]); name != "" {
			locationName = name
		}
	}
	timezone := stringOf(payload["timezone"])
	summary := fmt.Sprintf("%s 当前天气：%s，气温 %s℃，体感 %s℃，湿度 %s，风速 %s km/h。",
		locationName, describeCondition(stringOf(current["conditionCode"])),
		formatNumber(floatOf(current["temperature"]), 1), formatNumber(floatOf(current["temperatureApparent"]), 1),
		formatPercent(current["humidity"]), formatNumber(floatOf(current["windSpeed"]), 1))
	if len(daily) > 0 {
		lines := []string{summary, fmt.Sprintf("未来 %d 天：", len(daily))}
		for _, day := range daily {
			lines = append(lines, fmt.Sprintf("- %s：%s，%s ~ %s℃，降水概率 %s",
				formatDateLabel(day["date"]), day["condition"],
				formatNumber(day["temperatureMin"].(float64), 1), formatNumber(day["temperatureMax"].(float64), 1),
				day["precipitationChancePercent"]))
		}
		summary = strings.Join(lines, "\n")
	}
	return map[string]any{
		"ok": true, "location": locationName, "timezone": timezone,
		"daily": daily, "summary": summary, "source": "duckduckgo_weather",
	}, nil
}

// FetchCurrency 汇率换算（对齐 Node fetchCurrency：mid 是已换算金额，需除以请求金额还原汇率）。
func (s *Service) FetchCurrency(ctx context.Context, from string, to string, amount float64, timeoutMs int) (map[string]any, error) {
	fromCode := strings.ToUpper(strings.TrimSpace(from))
	toCode := strings.ToUpper(strings.TrimSpace(to))
	if fromCode == "" || toCode == "" {
		return nil, fmt.Errorf("需要提供源货币和目标货币，例如 USD 与 CNY")
	}
	if amount <= 0 || math.IsNaN(amount) {
		return nil, fmt.Errorf("金额必须是正数")
	}
	payload, err := s.fetchSpice(ctx, "currency/"+urlEncode(formatNumber(amount, 6))+"/"+urlEncode(fromCode)+"/"+urlEncode(toCode), timeoutMs)
	if err != nil {
		return nil, err
	}
	converted := math.NaN()
	if toList, ok := payload["to"].([]any); ok && len(toList) > 0 {
		if quote, ok := toList[0].(map[string]any); ok {
			converted = floatOf(quote["mid"])
		}
	}
	baseAmount := amount
	if payloadAmount := floatOf(payload["amount"]); payloadAmount > 0 {
		baseAmount = payloadAmount
	}
	rate := math.NaN()
	if !math.IsNaN(converted) && baseAmount > 0 {
		rate = converted / baseAmount
	}
	if payload == nil || math.IsNaN(converted) || math.IsNaN(rate) {
		return map[string]any{"ok": false, "from": fromCode, "to": toCode, "error": fmt.Sprintf("未找到 %s → %s 的汇率数据", fromCode, toCode)}, nil
	}
	timestamp := stringOf(payload["timestamp"])
	return map[string]any{
		"ok": true, "from": fromCode, "to": toCode, "amount": amount, "rate": rate, "converted": converted,
		"summary": fmt.Sprintf("%s %s ≈ %s %s（1 %s = %s %s，数据源 xe.com 中间价%s）",
			formatNumber(amount, 2), fromCode, formatNumber(converted, 4), toCode, fromCode, formatNumber(rate, 6), toCode, timestampTail(timestamp)),
		"source": "duckduckgo_currency",
	}, nil
}

func timestampTail(timestamp string) string {
	if timestamp == "" {
		return ""
	}
	return "，" + timestamp
}

func urlEncode(value string) string {
	return strings.ReplaceAll(strings.ReplaceAll(value, " ", "%20"), "/", "%2F")
}

func orStr(value string, fallback string) string {
	if value == "" {
		return fallback
	}
	return value
}

func stringOf(value any) string {
	if text, ok := value.(string); ok {
		return text
	}
	return ""
}

func floatOf(value any) float64 {
	if number, ok := value.(float64); ok {
		return number
	}
	return math.NaN()
}
