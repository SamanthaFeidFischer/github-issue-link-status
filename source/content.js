import 'webext-dynamic-content-scripts';
import OptionsSync from 'webext-options-sync';
import * as icons from './icons';
import formatDistance from 'date-fns/formatDistance'
import parseISO from 'date-fns/parseISO'

let token;
const __DEV__ = false;
const endpoint = (location.hostname === 'docs.sourcegraph.com' || location.host==='localhost:5080' || location.hostname === 'github.com') ? 'https://api.github.com/graphql' : `${location.origin}/api/graphql`;
const issueUrlRegex = /^[/]([^/]+[/][^/]+)[/](issues|pull)[/](\d+)([/]|$)/;
const stateColorMap = {
	open: 'text-green',
	closed: 'text-red',
	merged: 'text-purple'
};

if (location.hostname === 'docs.sourcegraph.com' || location.host==='localhost:5080') {
	document.body.insertAdjacentHTML('beforeend', `<style>
	.text-green { color: #28a745 !important; }
	.text-purple { color: #6f42c1 !important; }
	.text-red { color: #cb2431 !important; }
	</style>`)
}

function anySelector(selector) {
	const prefix = document.head.style.MozOrient === '' ? 'moz' : 'webkit';
	return selector.replace(/:any\(/g, `:-${prefix}-any(`);
}

function esc(repo) {
	return '_' + repo.replace(/[./-]/g, '_');
}

function query(q) {
	q = `query {${q}}`;
	if (__DEV__) {
		console.log(q);
	}
	return q
}

function join(iterable, merger) {
	return [...iterable.entries()].map(merger).join('\n');
}

function buildGQL(links) {
	const repoIssueMap = new Map();
	for (const {repo, id} of links) {
		const issues = repoIssueMap.get(repo) || new Set();
		issues.add(id);
		repoIssueMap.set(repo, issues);
	}

	const FIELDS = `
	number
	title
	bodyText
	state
	updatedAt
	milestone {
		title
	}
	assignees(first: 20) {
		nodes {
		  login
		}
	}
	`

	return query(
		join(repoIssueMap, ([repo, issues]) =>
			esc(repo) + `: repository(
				owner: "${repo.split('/')[0]}",
				name: "${repo.split('/')[1]}"
			) {${join(issues, ([id]) => `
				${esc(id)}: issueOrPullRequest(number: ${id}) {
					__typename
					... on PullRequest {
						${FIELDS}
					}
					... on Issue {
						${FIELDS}
					}
				}
			`)}}
		`)
	);
}

function getNewLinks() {
	const newLinks = new Set();
	const links = document.querySelectorAll(anySelector(`
		:any(
			.js-issue-title,
			.markdown-body
		)
		a[href^="${location.origin}"]:any(
			a[href*="/pull/"],
			a[href*="/issues/"]
		):not(.ILS)
	`));

	// For docs.sourcegraph.com:
	const docsLinks = document.querySelectorAll(anySelector(`
		#content
		a[href^="https://github.com/"]:any(
			a[href*="/pull/"],
			a[href*="/issues/"]
		):not(.ILS)
	`))

	for (const link of [...links, ...docsLinks]) {
		link.classList.add('ILS');
		let [, repo, type, id] = link.pathname.match(issueUrlRegex) || [];
		if (id) {
			type = type.replace('issues', 'issue').replace('pull', 'pullrequest');
			newLinks.add({link, repo, type, id});
		}
	}

	return newLinks;
}

async function apply() {
	const links = getNewLinks();
	if (links.size === 0) {
		return;
	}

	for (const {link, type} of links) {
		link.insertAdjacentHTML('beforeEnd', icons['open' + type]);
	}

	const query = buildGQL(links);
	const response = await fetch(endpoint, {
		method: 'POST',
		headers: {
			Authorization: `bearer ${token}`
		},
		body: JSON.stringify({query})
	});
	const {data} = await response.json();

	for (const {link, repo, id} of links) {
		try {
			const item = data[esc(repo)][esc(id)];
			const state = item.state.toLowerCase();
			const type = item.__typename.toLowerCase();

			const span = document.createElement('span')
			span.style = 'color:#aaa;font-size:80%'
			const extras = []
			if (!link.innerText.includes(item.number)) {
				extras.push(`#${item.number}`)
			}
			if (item.title.includes('WIP') || item.bodyText.includes('(WIP)') || item.bodyText.includes('(TODO)')) {
				const red = document.createElement('span')
				red.classList.add('text-red')
				red.style='font-weight:bold'
				red.innerText = 'Description WIP'
				extras.push(red)
			}
			if (item.milestone) {
				const strong = document.createElement('strong')
				strong.innerText = item.milestone.title
				extras.push(strong)
			}
			extras.push(`${formatDistance(parseISO(item.updatedAt), Date.now())} ago`)
			if (item.assignees && item.assignees.nodes && item.assignees.nodes.length > 0) {
				extras.push(item.assignees.nodes.map(({login}) => '@' + login).join(' '))
			}
			for (const e of extras) {
				span.appendChild(document.createTextNode(' '))
				span.appendChild(typeof e === 'string' ? document.createTextNode(e) : e)
			}
			span.title = item.title
			link.insertAdjacentElement('afterEnd', span)

			link.classList.add(stateColorMap[state]);
			if (state !== 'open' && state + type !== 'closedpullrequest') {
				link.querySelector('svg').outerHTML = icons[state + type];
			}
		} catch (error) {
			console.error(error)
			/* Probably a redirect */
		}
	}
}

function onAjaxedPages(cb) {
	cb();
	document.addEventListener('pjax:end', cb);
}

function onNewComments(cb) {
	cb();
	const commentList = document.querySelector('.js-discussion');
	if (commentList) {
		// When new comments come in via ajax
		new MutationObserver(cb).observe(commentList, {childList: true});

		// When you edit your own comment
		commentList.addEventListener('submit', () => setTimeout(cb, 1000)); // Close enough
	}
}

async function init() {
	const options = await new OptionsSync().getAll();
	({token} = options);
	if (token) {
		onAjaxedPages(() => onNewComments(apply));
	} else {
		console.error('GitHub Issue Link Status: you will need to set a token in the options for this extension to work.');
	}
}

init();
