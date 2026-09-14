package search

import (
	"strings"
	"testing"
)

func TestSpiceParseHelpers(t *testing.T) {
	if describeCondition("Clear") != "晴" || describeCondition("PartlyCloudy") != "多云" {
		t.Fatal("天气代码映射异常")
	}
	if describeCondition("") != "未知" || describeCondition("CustomCode") != "CustomCode" {
		t.Fatal("未知代码应原样返回")
	}
	if formatPercent(0.3) != "30%" || formatPercent(40.0) != "40%" {
		t.Fatal("百分比归一异常")
	}
	if formatNumber(25.0, 1) != "25.0" {
		t.Fatal("数字格式化异常")
	}
	if formatDateLabel("2026-09-14") != "9/14" {
		t.Fatalf("日期标签异常: %s", formatDateLabel("2026-09-14"))
	}
}

func TestSpiceWrapperParsing(t *testing.T) {
	wrapper := "ddg_spice_forecast(\n{\"currentWeather\":{\"temperature\":25}}\n);"
	match := spiceWrapperRE.FindStringSubmatch(wrapper)
	if match == nil {
		t.Fatal("包装剥离失败")
	}
	if !strings.Contains(match[1], "currentWeather") {
		t.Fatalf("剥离内容异常: %s", match[1])
	}
	if !spiceEmptyRE.MatchString("ddg_spice_x( )") {
		t.Fatal("空响应应识别")
	}
}
