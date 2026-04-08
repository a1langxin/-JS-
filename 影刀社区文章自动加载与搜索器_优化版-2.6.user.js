// ==UserScript==
// @name         影刀社区文章自动加载与搜索器和排序3.0-正式版
// @namespace    http://tampermonkey.net/
// @version      2.6
// @description  优化影刀社区页面，支持大量文章自动加载（每次500条）和搜索功能，精简代码，提升性能，修复栏目识别问题，修复收藏栏目加载数量(支持Fetch和XHR)
// @author       Antigravity
// @match        *://www.yingdao.com/community/userCenter?userUuid*
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    // --- 1. 配置与常量 ---
    const 配置 = {
        每页加载数量: 500,
        初始延时: 2000,       // 普通栏目切换等待
        回答栏目延时: 4000,   // 回答栏目特殊等待
        检查间隔: 3000,       // 自动加载检查间隔
        重试间隔: 2000,       // 按钮查找失败重试间隔
        最大重试次数: 15      // 连续未找到按钮的最大重试次数
    };

    const 选择器 = {
        // 页面元素选择器
        查看更多按钮: [
            "//span[normalize-space(text())='查看更多']",
            ".rc-tabs-tabpane-active span:contains('查看更多')",
            "span" // 兜底
        ],
        内容项: [
            '.list___18bDQ > div',
            '.list_item___nmNeS',
            '.qa-item, .article-item, .answer-item',
            '[class*="item"]',
            'a[href*="/community/"]'
        ],
        // 严格匹配的按钮XPath
        按钮: {
            PUBLISH: {
                提问: '//div[@id="rc-tabs-0-panel-PUBLISH"]//div[contains(@class, "btn___N0geJ")]//div//button[contains(text(),"提问")]',
                回答: '//div[@id="rc-tabs-0-panel-PUBLISH"]//div[contains(@class, "btn___N0geJ")]//div//button[contains(text(),"回答")]',
                文章: '//div[@id="rc-tabs-0-panel-PUBLISH"]//div[contains(@class, "btn___N0geJ")]//div//button[contains(text(),"文章")]'
            },
            COLLECT: {
                问答: '//div[@id="rc-tabs-0-panel-COLLECT"]//div[contains(@class, "btn___N0geJ")]//div//button[contains(text(),"问答")]',
                文章: '//div[@id="rc-tabs-0-panel-COLLECT"]//div[contains(@class, "btn___N0geJ")]//div//button[contains(text(),"文章")]'
            }
        }
    };

    // --- 2. 全局状态 ---
    const 状态 = {
        大栏目: 'PUBLISH',    // PUBLISH 或 COLLECT
        子栏目: '提问',       // 提问, 回答, 文章, 问答
        已加载数量: 0,
        总数量: 0,
        正在加载: false,
        加载定时器: null,
        重试计数: 0,
        手动切换: false,      // 标记是否刚进行了手动切换
        文章数据: [],          // 保存文章数据，包含 createTime 和原始顺序
        原始顺序: [],          // 保存原始 DOM 顺序
        排序模式: false        // 是否处于排序模式
    };

    // --- 3. 初始化 ---
    function 初始化() {
        console.log('影刀社区优化脚本 v2.6 启动...');

        注入API拦截器();
        添加搜索框();
        设置全局事件监听();

        // 初始状态同步
        setTimeout(() => {
            同步状态();
            开始自动加载();

            // 检查本地存储中的排序状态
            setTimeout(检查并应用排序状态, 3000); // 延迟执行，确保页面已加载完成
        }, 1000);

        window.addEventListener('error', e => console.error('全局错误:', e.message));
    }

    // --- 4. 核心功能：API拦截 ---
    function 注入API拦截器() {
        const 目标APIs = [
            'queryUserPublishList',
            'queryUserAnswerList',
            'queryUserQuestionList',
            'queryUserFavoriteList',
            'queryCollectionList'
        ];

        function 是目标API(url) {
            return typeof url === 'string' && 目标APIs.some(api => url.includes(api));
        }

        function 处理响应数据(responseData) {
            try {
                const data = typeof responseData === 'string' ? JSON.parse(responseData) : responseData;
                let 文章列表 = [];

                // 尝试从响应中获取文章列表
                if (data.data && data.data.list) {
                    文章列表 = data.data.list;
                } else if (data.data && Array.isArray(data.data)) {
                    文章列表 = data.data;
                } else if (data.list) {
                    文章列表 = data.list;
                } else if (Array.isArray(data)) {
                    文章列表 = data;
                }

                if (文章列表.length > 0) {
                    // 保存文章数据，包含 createTime
                    状态.文章数据 = 文章列表.map((item, index) => ({
                        createTime: item.createTime || item.create_time || '',
                        index: index,
                        data: item
                    }));
                    console.log(`[API响应] 已保存 ${文章列表.length} 条文章数据`);
                }
            } catch (e) {
                console.error('[API响应] 处理响应数据出错:', e);
            }
        }

        function 获取修改后的URL(url) {
            if (!url || !url.includes('?')) return url;
            try {
                const [base, search] = url.split('?');
                const params = new URLSearchParams(search);
                let modified = false;

                ['size', 'pageSize', 'limit', 'count'].forEach(key => {
                    if (params.has(key)) {
                        console.log(`[API拦截] 发现URL参数: ${key}=${params.get(key)} -> ${配置.每页加载数量}`);
                        params.set(key, 配置.每页加载数量);
                        modified = true;
                    }
                });

                // 针对收藏列表的特殊处理：如果没有分页参数，强制添加
                if (!modified && url.includes('queryUserFavoriteList')) {
                    console.log(`[API拦截] 未找到分页参数，强制添加 pageSize=${配置.每页加载数量}`);
                    params.set('pageSize', 配置.每页加载数量);
                    modified = true;
                }

                if (modified) {
                    return `${base}?${params.toString()}`;
                }
            } catch (e) {
                console.error('[API拦截] URL处理出错:', e);
            }
            return url;
        }

        function 获取修改后的Body(bodyStr) {
            try {
                const 请求体 = JSON.parse(bodyStr);
                let modified = false;

                ['size', 'pageSize', 'limit', 'count'].forEach(key => {
                    if (请求体[key] !== undefined) {
                        console.log(`[API拦截] 发现Body参数: ${key}=${请求体[key]} -> ${配置.每页加载数量}`);
                        请求体[key] = 配置.每页加载数量;
                        modified = true;
                    }
                });

                // 补充 userUuid
                const urlUuid = new URLSearchParams(window.location.search).get('userUuid');
                if (urlUuid && 请求体.userUuid) {
                    请求体.userUuid = urlUuid;
                }

                if (modified) {
                    return JSON.stringify(请求体);
                }
            } catch (e) {
                // 不是JSON或解析失败，忽略
            }
            return bodyStr;
        }

        // 1. 拦截 Fetch
        try {
            const 原始Fetch = window.fetch;
            window.fetch = function (...args) {
                let url = args[0];
                let options = args[1] || {};
                let targetUrl = url instanceof Request ? url.url : url;
                let isTarget = 是目标API(targetUrl);

                if (url instanceof Request) {
                    // 简单处理 Request 对象：只尝试修改 URL
                    if (isTarget) {
                        console.log(`[Fetch拦截] 捕获 Request 对象: ${targetUrl}`);
                    }
                } else if (isTarget) {
                    console.log(`[Fetch拦截] 捕获请求: ${targetUrl}`);

                    // 修改 URL
                    const newUrl = 获取修改后的URL(url);
                    if (newUrl !== url) {
                        args[0] = newUrl;
                        console.log(`[Fetch拦截] URL已修改`);
                    }

                    // 修改 Body
                    if (options.body) {
                        const newBody = 获取修改后的Body(options.body);
                        if (newBody !== options.body) {
                            options.body = newBody;
                            args[1] = options;
                            console.log(`[Fetch拦截] Body已修改`);
                        }
                    }
                }

                return 原始Fetch.apply(this, args).then(response => {
                    if (isTarget) {
                        // 克隆响应以便读取和处理
                        const clonedResponse = response.clone();
                        clonedResponse.text().then(text => {
                            处理响应数据(text);
                        }).catch(e => console.error('[Fetch响应] 读取响应失败:', e));
                    }
                    return response;
                });
            };
            console.log('Fetch 拦截器注入成功');
        } catch (e) {
            console.error('Fetch 拦截器注入失败:', e);
        }

        // 2. 拦截 XHR (XMLHttpRequest)
        try {
            const 原始Open = XMLHttpRequest.prototype.open;
            const 原始Send = XMLHttpRequest.prototype.send;

            XMLHttpRequest.prototype.open = function (method, url, ...rest) {
                this._url = url; // 保存 URL 供 send 使用
                this._isTarget = 是目标API(url);
                if (this._isTarget) {
                    console.log(`[XHR拦截] open: ${url}`);
                    const newUrl = 获取修改后的URL(url);
                    if (newUrl !== url) {
                        url = newUrl;
                        console.log(`[XHR拦截] URL已修改`);
                    }
                }
                return 原始Open.call(this, method, url, ...rest);
            };

            XMLHttpRequest.prototype.send = function (body) {
                if (this._isTarget && body) {
                    console.log(`[XHR拦截] send body:`, body);
                    const newBody = 获取修改后的Body(body);
                    if (newBody !== body) {
                        body = newBody;
                        console.log(`[XHR拦截] Body已修改`);
                    }
                }

                // 监听响应
                const self = this;
                const originalOnReadyStateChange = this.onreadystatechange;
                this.onreadystatechange = function () {
                    if (self.readyState === 4 && self._isTarget) {
                        try {
                            处理响应数据(self.responseText);
                        } catch (e) {
                            console.error('[XHR响应] 处理响应失败:', e);
                        }
                    }
                    if (originalOnReadyStateChange) {
                        originalOnReadyStateChange.apply(this, arguments);
                    }
                };

                return 原始Send.call(this, body);
            };
            console.log('XHR 拦截器注入成功');
        } catch (e) {
            console.error('XHR 拦截器注入失败:', e);
        }
    }

    // --- 5. 核心功能：状态管理 ---
    function 同步状态() {
        try {
            // 如果刚进行了手动切换，跳过一次自动检测
            if (状态.手动切换) {
                状态.手动切换 = false;
                更新已加载统计();
                console.log(`状态同步(手动后): [${状态.大栏目}-${状态.子栏目}] 已加载: ${状态.已加载数量}/${状态.总数量}`);
                return;
            }

            // 1. 确定大栏目
            const 激活面板 = document.querySelector('.rc-tabs-tabpane-active');
            if (激活面板) {
                if (激活面板.id.includes('PUBLISH')) 状态.大栏目 = 'PUBLISH';
                else if (激活面板.id.includes('COLLECT')) 状态.大栏目 = 'COLLECT';
            }

            // 2. 确定子栏目
            let 识别到的子栏目 = null;
            const 按钮组 = 状态.大栏目 === 'PUBLISH' ? 选择器.按钮.PUBLISH : 选择器.按钮.COLLECT;

            for (const [名称, xpath] of Object.entries(按钮组)) {
                const btn = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
                if (btn) {
                    const style = window.getComputedStyle(btn);
                    if (btn.classList.contains('active') ||
                        btn.parentNode.classList.contains('active') ||
                        style.color === 'rgb(59, 130, 246)' ||
                        style.fontWeight === '700' ||
                        style.fontWeight === 'bold') {
                        识别到的子栏目 = 名称;
                        break;
                    }
                }
            }

            if (识别到的子栏目) {
                状态.子栏目 = 识别到的子栏目;
            }

            // 3. 获取总数量
            const 目标按钮XPath = 按钮组[状态.子栏目];
            if (目标按钮XPath) {
                const btn = document.evaluate(目标按钮XPath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
                if (btn) {
                    const 文本 = btn.textContent;
                    const 匹配 = 文本.match(/\((\d+)\)/);
                    if (匹配) {
                        状态.总数量 = parseInt(匹配[1], 10);
                    }
                }
            }

            // 4. 更新已加载数量
            更新已加载统计();

            console.log(`状态同步: [${状态.大栏目}-${状态.子栏目}] 已加载: ${状态.已加载数量}/${状态.总数量}`);

        } catch (e) {
            console.error('同步状态失败:', e);
        }
    }

    function 更新已加载统计() {
        const 面板ID = 状态.大栏目 === 'PUBLISH' ? 'rc-tabs-0-panel-PUBLISH' : 'rc-tabs-0-panel-COLLECT';
        const 面板 = document.getElementById(面板ID);

        // 如果找不到面板，说明页面可能还没加载好，暂时返回0
        if (!面板) {
            状态.已加载数量 = 0;
            return;
        }

        let 计数 = 0;
        for (const sel of 选择器.内容项) {
            // 严格在当前面板下查找
            const items = 面板.querySelectorAll(sel);
            if (items.length > 0) {
                计数 = items.length;
                break;
            }
        }
        状态.已加载数量 = 计数;
    }

    // --- 6. 核心功能：自动加载 ---
    function 开始自动加载() {
        if (状态.加载定时器) clearInterval(状态.加载定时器);

        状态.重试计数 = 0;
        检查并加载();

        状态.加载定时器 = setInterval(检查并加载, 配置.检查间隔);
        console.log('自动加载已启动');
    }

    function 检查并加载() {
        if (状态.正在加载) return;

        if (状态.总数量 > 0 && 状态.已加载数量 >= 状态.总数量) {
            return;
        }

        if (状态.重试计数 >= 配置.最大重试次数) {
            console.log(`连续 ${状态.重试计数} 次未找到加载按钮，停止自动加载`);
            clearInterval(状态.加载定时器);
            状态.加载定时器 = null;
            return;
        }

        // 查找"查看更多"按钮
        let 按钮 = null;
        try {
            const result = document.evaluate(选择器.查看更多按钮[0], document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
            按钮 = result.singleNodeValue;
        } catch (e) { }

        if (!按钮) {
            const spans = document.querySelectorAll('span');
            for (const span of spans) {
                if (span.textContent.trim() === '查看更多') {
                    按钮 = span;
                    break;
                }
            }
        }

        if (按钮) {
            状态.正在加载 = true;
            状态.重试计数 = 0;
            console.log('点击"查看更多"...');
            按钮.click();

            setTimeout(() => {
                状态.正在加载 = false;
                同步状态();
            }, 2000 + Math.random() * 1000);
        } else {
            状态.重试计数++;
            if (状态.重试计数 % 5 === 0) {
                console.log(`未找到加载按钮 (重试 ${状态.重试计数}/${配置.最大重试次数})`);
            }
        }
    }

    // --- 7. 核心功能：搜索 ---
    function 添加搜索框() {
        const div = document.createElement('div');
        div.innerHTML = `
            <div style="position:fixed; top:10px; right:20px; z-index:9999; background:white; padding:10px; border-radius:6px; box-shadow:0 2px 10px rgba(0,0,0,0.1); display:flex; align-items:center; flex-wrap:wrap; gap:8px;">
                <input id="yd-search-input" type="text" placeholder="搜索内容..." style="padding:8px; border:1px solid #d9d9d9; border-radius:4px; width:200px;">
                <button id="yd-search-btn" style="padding:8px 16px; background:#1890ff; color:white; border:none; border-radius:4px; cursor:pointer;">搜索</button>
                <button id="yd-clear-btn" style="padding:8px 16px; background:#f0f0f0; border:1px solid #d9d9d9; border-radius:4px; cursor:pointer;">清除</button>
                <button id="yd-sort-btn" style="padding:8px 16px; background:#52c41a; color:white; border:none; border-radius:4px; cursor:pointer;">按时间排序</button>
                <button id="yd-reset-sort-btn" style="padding:8px 16px; background:#faad14; color:white; border:none; border-radius:4px; cursor:pointer; display:none;">取消排序</button>
            </div>
        `;
        document.body.appendChild(div);

        const input = document.getElementById('yd-search-input');
        const searchBtn = document.getElementById('yd-search-btn');
        const clearBtn = document.getElementById('yd-clear-btn');
        const sortBtn = document.getElementById('yd-sort-btn');
        const resetSortBtn = document.getElementById('yd-reset-sort-btn');

        const handleSearch = () => 执行搜索(input.value);

        searchBtn.onclick = handleSearch;
        clearBtn.onclick = () => { input.value = ''; 执行搜索(''); };
        input.onkeypress = (e) => { if (e.key === 'Enter') handleSearch(); };
        input.oninput = () => { if (!input.value.trim()) 执行搜索(''); };

        sortBtn.onclick = () => {
            按时间排序();
            sortBtn.style.display = 'none';
            resetSortBtn.style.display = 'inline-block';
        };
        resetSortBtn.onclick = () => {
            恢复原始顺序();
            sortBtn.style.display = 'inline-block';
            resetSortBtn.style.display = 'none';
        };
    }

    function 执行搜索(关键词) {
        关键词 = 关键词.trim().toLowerCase();
        清除高亮();

        const 面板ID = 状态.大栏目 === 'PUBLISH' ? 'rc-tabs-0-panel-PUBLISH' : 'rc-tabs-0-panel-COLLECT';
        const 面板 = document.getElementById(面板ID);
        
        // 如果找不到面板，直接退出
        if (!面板) {
            显示提示('未找到内容面板', false);
            return;
        }

        let 所有项目 = [];
        for (const sel of 选择器.内容项) {
            const 候选项目 = Array.from(面板.querySelectorAll(sel));
            所有项目 = 候选项目.filter(item => {
                // 只排除明确的按钮元素
                const isButtonElement = item.tagName === 'BUTTON';
                const isInButtonContainer = item.closest('.btn___N0geJ') !== null;
                return !isButtonElement && !isInButtonContainer;
            });
            if (所有项目.length > 0) break;
        }

        if (所有项目.length === 0) {
            显示提示('未找到可搜索的内容项', false);
            return;
        }

        if (!关键词) {
            所有项目.forEach(item => item.style.display = '');
            显示提示('已显示所有内容');
            return;
        }

        let 匹配数 = 0;
        所有项目.forEach(item => {
            const 文本 = item.textContent.toLowerCase();
            if (文本.includes(关键词)) {
                item.style.display = '';
                高亮关键词(item, 关键词);
                匹配数++;
            } else {
                item.style.display = 'none';
            }
        });

        if (匹配数 > 0) {
            const 可见项 = 所有项目.find(i => i.style.display !== 'none');
            if (可见项) 可见项.scrollIntoView({ behavior: 'smooth', block: 'center' });
            显示提示(`找到 ${匹配数} 条相关内容`);
        } else {
            显示提示('未找到匹配内容', false);
        }
    }

    function 高亮关键词(element, keyword) {
        const regex = new RegExp(`(${keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
        (function traverse(node) {
            if (node.nodeType === 3) {
                const text = node.textContent;
                if (regex.test(text)) {
                    const fragment = document.createDocumentFragment();
                    let lastIdx = 0;
                    text.replace(regex, (match, p1, offset) => {
                        fragment.appendChild(document.createTextNode(text.slice(lastIdx, offset)));
                        const span = document.createElement('span');
                        span.style.backgroundColor = '#ffeb3b';
                        span.className = 'yd-highlight';
                        span.textContent = match;
                        fragment.appendChild(span);
                        lastIdx = offset + match.length;
                    });
                    fragment.appendChild(document.createTextNode(text.slice(lastIdx)));
                    node.parentNode.replaceChild(fragment, node);
                }
            } else if (node.nodeType === 1 && node.tagName !== 'SCRIPT' && node.tagName !== 'STYLE') {
                Array.from(node.childNodes).forEach(traverse);
            }
        })(element);
    }

    function 清除高亮() {
        document.querySelectorAll('.yd-highlight').forEach(span => {
            const parent = span.parentNode;
            parent.replaceChild(document.createTextNode(span.textContent), span);
            parent.normalize();
        });
    }

    function 显示提示(msg, success = true) {
        let tip = document.getElementById('yd-search-tip');
        if (!tip) {
            tip = document.createElement('div');
            tip.id = 'yd-search-tip';
            tip.style.cssText = 'position:fixed; top:70px; left:50%; transform:translateX(-50%); padding:10px 20px; border-radius:4px; color:white; z-index:10000; transition:opacity 0.3s;';
            document.body.appendChild(tip);
        }
        tip.textContent = msg;
        tip.style.background = success ? '#52c41a' : '#ff4d4f';
        tip.style.opacity = '1';
        tip.style.display = 'block';
        setTimeout(() => {
            tip.style.opacity = '0';
            setTimeout(() => tip.style.display = 'none', 300);
        }, 3000);
    }

    // --- 9. 核心功能：按时间排序 ---
    function 按时间排序(isAutoRestore = false) {
        const 面板ID = 状态.大栏目 === 'PUBLISH' ? 'rc-tabs-0-panel-PUBLISH' : 'rc-tabs-0-panel-COLLECT';
        const 面板 = document.getElementById(面板ID);
        
        // 如果找不到面板，直接退出
        if (!面板) {
            显示提示('未找到内容面板', false);
            return;
        }

        // 获取当前面板下的所有文章项目
        let 所有项目 = [];
        for (const sel of 选择器.内容项) {
            const 候选项目 = Array.from(面板.querySelectorAll(sel));
            所有项目 = 候选项目.filter(item => {
                // 只排除明确的按钮元素
                const isButtonElement = item.tagName === 'BUTTON';
                const isInButtonContainer = item.closest('.btn___N0geJ') !== null;
                return !isButtonElement && !isInButtonContainer;
            });
            if (所有项目.length > 0) break;
        }

        if (所有项目.length === 0) {
            显示提示('未找到可排序的内容项', false);
            return;
        }

        // 只在用户主动点击时保存原始顺序和状态
        if (!isAutoRestore) {
            // 保存原始顺序
            状态.原始顺序 = 所有项目.slice();
            状态.排序模式 = true;

            // 保存排序状态到本地存储（按栏目保存）
            try {
                const sortState = JSON.parse(localStorage.getItem('yd_sort_state') || '{}');
                const key = `${状态.大栏目}-${状态.子栏目}`;
                sortState[key] = true;
                localStorage.setItem('yd_sort_state', JSON.stringify(sortState));
                console.log(`保存排序状态: ${key} = true`);
            } catch (e) {
                console.error('保存排序状态失败:', e);
            }
        } else {
            // 自动恢复时，先保存当前顺序作为原始顺序
            if (状态.原始顺序.length === 0) {
                状态.原始顺序 = 所有项目.slice();
            }
            状态.排序模式 = true;
        }

        // 尝试从文章元素中提取时间信息（备用方案）
        let 项目时间映射 = [];
        所有项目.forEach((item, index) => {
            let 时间字符串 = '';

            // 优先使用 API 保存的数据
            if (状态.文章数据[index] && 状态.文章数据[index].createTime) {
                时间字符串 = 状态.文章数据[index].createTime;
            } else {
                // 尝试从元素文本中提取时间（格式如 "2023-10-23 11:05:52"）
                const 文本 = item.textContent;
                const 时间匹配 = 文本.match(/(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})/);
                if (时间匹配) {
                    时间字符串 = 时间匹配[1];
                }
            }

            项目时间映射.push({
                element: item,
                createTime: 时间字符串,
                originalIndex: index
            });
        });

        // 按创建时间降序排序（最新的在前）
        项目时间映射.sort((a, b) => {
            if (!a.createTime) return 1;
            if (!b.createTime) return -1;
            return new Date(b.createTime).getTime() - new Date(a.createTime).getTime();
        });

        // 重新排列 DOM
        const 父容器 = 所有项目[0].parentNode;
        项目时间映射.forEach(item => {
            父容器.appendChild(item.element);
        });

        if (!isAutoRestore) {
            显示提示('已按发布时间排序（最新在前）');
        }
    }

    function 恢复原始顺序() {
        if (!状态.排序模式 || 状态.原始顺序.length === 0) {
            显示提示('没有可恢复的顺序', false);
            return;
        }

        if (状态.原始顺序[0] && 状态.原始顺序[0].parentNode) {
            const 父容器 = 状态.原始顺序[0].parentNode;
            状态.原始顺序.forEach(item => {
                父容器.appendChild(item);
            });
        }

        状态.排序模式 = false;

        // 清除本地存储中的排序状态（按栏目清除）
        try {
            const sortState = JSON.parse(localStorage.getItem('yd_sort_state') || '{}');
            const key = `${状态.大栏目}-${状态.子栏目}`;
            delete sortState[key];
            localStorage.setItem('yd_sort_state', JSON.stringify(sortState));
            console.log(`清除排序状态: ${key}`);
        } catch (e) {
            console.error('清除排序状态失败:', e);
        }

        显示提示('已恢复原始顺序');
    }

    // 检查并应用当前栏目的排序状态
    function 检查并应用排序状态() {
        try {
            const sortState = JSON.parse(localStorage.getItem('yd_sort_state') || '{}');
            const key = `${状态.大栏目}-${状态.子栏目}`;
            const isSorted = sortState[key] === true;

            console.log(`检查排序状态: ${key} = ${isSorted}`);

            // 更新按钮显示状态
            const sortBtn = document.getElementById('yd-sort-btn');
            const resetSortBtn = document.getElementById('yd-reset-sort-btn');

            if (isSorted) {
                if (sortBtn) sortBtn.style.display = 'none';
                if (resetSortBtn) resetSortBtn.style.display = 'inline-block';
                // 延迟执行排序，确保DOM已加载，使用自动恢复模式
                setTimeout(() => {
                    按时间排序(true);
                }, 500);
            } else {
                if (sortBtn) sortBtn.style.display = 'inline-block';
                if (resetSortBtn) resetSortBtn.style.display = 'none';
            }
        } catch (e) {
            console.error('检查排序状态失败:', e);
        }
    }

    // 在栏目切换时重置排序状态
    function 重置排序状态() {
        状态.文章数据 = [];
        状态.原始顺序 = [];
        状态.排序模式 = false;

        // 检查并应用当前栏目的排序状态
        setTimeout(检查并应用排序状态, 1000);
    }

    // --- 8. 事件监听优化 ---
    function 设置全局事件监听() {
        document.addEventListener('click', (e) => {
            const target = e.target;
            const btn = target.closest('button') || target.closest('.rc-tabs-tab');
            if (btn) {
                const text = btn.textContent;

                // 1. 检查是否是大栏目切换 (发布/收藏)
                if (text.includes('发布') || text.includes('收藏')) {
                    // 如果是Tab点击，通常会有 data-tab-key 或类似的属性，或者根据文本判断
                    if (text.includes('发布')) 状态.大栏目 = 'PUBLISH';
                    if (text.includes('收藏')) 状态.大栏目 = 'COLLECT';
                    console.log(`检测到大栏目切换: ${状态.大栏目}`);
                    // 重置子栏目为默认值
                    状态.子栏目 = 状态.大栏目 === 'PUBLISH' ? '提问' : '问答';
                    // 重置排序状态
                    重置排序状态();
                    return;
                }

                // 2. 检查是否是子栏目切换
                if (text.includes('提问') || text.includes('回答') || text.includes('文章') || text.includes('问答')) {
                    console.log(`检测到子栏目切换点击: ${text}`);

                    // 关键修复：判断按钮所属的父面板
                    const parentPanel = btn.closest('[id^="rc-tabs-0-panel-"]');
                    if (parentPanel) {
                        if (parentPanel.id.includes('PUBLISH')) 状态.大栏目 = 'PUBLISH';
                        else if (parentPanel.id.includes('COLLECT')) 状态.大栏目 = 'COLLECT';
                    } else {
                        // 如果找不到父面板（可能是DOM结构差异），尝试根据当前状态推断
                        // 但为了保险，我们优先信任之前的状态，或者根据按钮文本特征
                        // 收藏栏目没有"提问"和"回答"，只有"问答"和"文章"
                        // 发布栏目有"提问"、"回答"、"文章"
                        if (text.includes('提问') || text.includes('回答')) 状态.大栏目 = 'PUBLISH';
                        if (text.includes('问答')) 状态.大栏目 = 'COLLECT';
                        // "文章"是共有的，保持当前大栏目不变
                    }

                    // 更新子栏目
                    if (text.includes('提问')) 状态.子栏目 = '提问';
                    else if (text.includes('回答')) 状态.子栏目 = '回答';
                    else if (text.includes('文章')) 状态.子栏目 = '文章';
                    else if (text.includes('问答')) 状态.子栏目 = '问答';

                    // 提取总数
                    const match = text.match(/\((\d+)\)/);
                    if (match) {
                        状态.总数量 = parseInt(match[1], 10);
                    }

                    状态.手动切换 = true;
                    console.log(`状态更新(点击): [${状态.大栏目}-${状态.子栏目}] 总数: ${状态.总数量}`);

                    // 重置排序状态
                    重置排序状态();

                    const delay = text.includes('回答') ? 配置.回答栏目延时 : 配置.初始延时;
                    setTimeout(() => {
                        同步状态();
                        清除高亮();
                        开始自动加载();
                    }, delay);
                }
            }
        });

        const observer = new MutationObserver((mutations) => {
            let hasAddedNodes = false;
            mutations.forEach(m => { if (m.addedNodes.length > 0) hasAddedNodes = true; });
            if (hasAddedNodes) {
                更新已加载统计();
                if (!状态.正在加载 && 状态.总数量 > 0 && 状态.已加载数量 < 状态.总数量) {
                    检查并加载();
                }
            }
        });
        const container = document.querySelector('.rc-tabs-content') || document.body;
        observer.observe(container, { childList: true, subtree: true });
    }

    setTimeout(初始化, 1000);
})();
