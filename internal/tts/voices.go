package tts

// qwenVoices Qwen-TTS 非实时语音合成系统音色
// 来源: https://help.aliyun.com/zh/model-studio/qwen-tts-voice-list
var qwenVoices = map[string]string{
	"Cherry":      "芊悦-阳光积极、亲切自然小姐姐（女）",
	"Serena":      "苏瑶-温柔小姐姐（女）",
	"Ethan":       "晨煦-阳光温暖活力朝气（男）",
	"Chelsie":     "千雪-二次元虚拟女友（女）",
	"Momo":        "茉兔-撒娇搞怪（女）",
	"Vivian":      "十三-拽拽的可爱小暴躁（女）",
	"Moon":        "月白-率性帅气（男）",
	"Maia":        "四月-知性与温柔（女）",
	"Kai":         "凯-耳朵的一场SPA（男）",
	"Nofish":      "不吃鱼-不会翘舌音的设计师（男）",
	"Bella":       "萌宝-喝酒不打醉拳的小萝莉（女）",
	"Jennifer":    "詹妮弗-品牌级电影质感美语女声（女）",
	"Ryan":        "甜茶-节奏拉满戏感炸裂（男）",
	"Katerina":    "卡捷琳娜-御姐音色（女）",
	"Aiden":       "艾登-精通厨艺的美语大男孩（男）",
	"Eldric Sage": "沧明子-沉稳睿智的老者（男）",
	"Mia":         "乖小妹-温顺乖巧（女）",
	"Mochi":       "沙小弥-聪明伶俐的小大人（男）",
	"Bellona":     "燕铮莺-声音洪亮吐字清晰（女）",
	"Vincent":     "田叔-沙哑烟嗓（男）",
	"Bunny":       "萌小姬-萌属性爆棚的小萝莉（女）",
	"Neil":        "阿闻-专业新闻主持人（男）",
	"Elias":       "墨讲师-严谨又会叙事（女）",
	"Arthur":      "徐大爷-岁月与旱烟浸泡的质朴嗓音（男）",
	"Nini":        "邻家妹妹-又软又黏的嗓音（女）",
	"Seren":       "小婉-温和舒缓助眠声线（女）",
	"Pip":         "顽屁小孩-调皮捣蛋充满童真（男）",
	"Stella":      "少女阿月-甜到发腻的迷糊少女（女）",
	"Bodega":      "博德加-热情的西班牙大叔（男）",
	"Sonrisa":     "索尼莎-热情开朗的拉美大姐（女）",
	"Alek":        "阿列克-战斗民族的冷（男）",
	"Dolce":       "多尔切-慵懒的意大利大叔（男）",
	"Sohee":       "素熙-温柔开朗的韩国欧尼（女）",
	"Ono Anna":    "小野杏-鬼灵精怪的青梅竹马（女）",
	"Lenn":        "莱恩-穿西装听后朋克的德国青年（男）",
	"Emilien":     "埃米尔安-浪漫的法国大哥哥（男）",
	"Andre":       "安德雷-声音磁性自然沉稳（男）",
	"Radio Gol":   "拉迪奥·戈尔-足球诗人（男）",
	"Jada":        "上海-阿珍-风风火火的沪上阿姐（女/上海话）",
	"Dylan":       "北京-晓东-北京胡同里长大的少年（男/北京话）",
	"Li":          "南京-老李-耐心的瑜伽老师（男/南京话）",
	"Marcus":      "陕西-秦川-面宽话短心实声沉（男/陕西话）",
	"Roy":         "闽南-阿杰-诙谐直爽市井活泼（男/闽南语）",
	"Peter":       "天津-李彼得-天津相声专业捧哏（男/天津话）",
	"Sunny":       "四川-晴儿-甜到你心里的川妹子（女/四川话）",
	"Eric":        "四川-程川-跳脱市井的成都男子（男/四川话）",
	"Rocky":       "粤语-阿强-幽默风趣在线陪聊（男/粤语）",
	"Kiki":        "粤语-阿清-甜美的港妹闺蜜（女/粤语）",
}

// mimoVoices MiMo-V2.5-TTS 预置音色
// 来源: https://mimo.mi.com/docs/zh-CN/quick-start/usage-guide/audio/speech-synthesis-v2.5
var mimoVoices = map[string]string{
	"mimo_default": "MiMo-默认（中国集群默认为 冰糖Mia）",
	"冰糖":           "中文女声",
	"茉莉":           "中文女声",
	"苏打":           "中文男声",
	"白桦":           "中文男声",
	"Mia":          "英文女声",
	"Chloe":        "英文女声",
	"Milo":         "英文男声",
	"Dean":         "英文男声",
}

// minimaxVoices MiniMax 常用系统音色
// 来源: https://platform.minimaxi.com/document/T2A%20V2（voice_id 列表）
var minimaxVoices = map[string]string{
	"male-qn-qingse":     "青涩青年",
	"male-qn-jingying":   "精英青年",
	"male-qn-badao":      "霸道青年",
	"male-qn-daxuesheng": "大学生男生",
	"female-shaonv":      "少女",
	"female-yujie":       "御姐",
	"female-chengshu":    "成熟女性",
	"female-tianmei":     "甜美女性",
	"presenter_male":     "主持男声",
	"presenter_female":   "主持女声",
}

// VoicesForProvider 返回指定供应商的音色列表（按 id 排序），形状 [{id,name}] 与 Node 一致。
func VoicesForProvider(provider string) []map[string]string {
	var table map[string]string
	switch provider {
	case "qwen":
		table = qwenVoices
	case "mimo":
		table = mimoVoices
	case "minimax":
		table = minimaxVoices
	default:
		table = voiceTypesDoubao
	}
	result := make([]map[string]string, 0, len(table))
	for id, name := range table {
		result = append(result, map[string]string{"id": id, "name": name})
	}
	// 稳定排序
	for i := 1; i < len(result); i++ {
		for j := i; j > 0 && result[j]["id"] < result[j-1]["id"]; j-- {
			result[j], result[j-1] = result[j-1], result[j]
		}
	}
	return result
}
