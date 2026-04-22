# Cat Crawler: why I built it, what is interesting about it, and what I would improve next

Official links:

- Project page: [https://carlashub.github.io/site-crawler/](https://carlashub.github.io/site-crawler/)
- Repository: [https://github.com/CarlasHub/site-crawler](https://github.com/CarlasHub/site-crawler)

<video src="./assets/media/site-crawler-demo.webm" controls muted playsinline preload="metadata" poster="./assets/screenshots/01-dashboard.png" width="100%"></video>

If the video does not render inline in your browser, open [the demo video directly](./assets/media/site-crawler-demo.webm).

Cat Crawler started from a pretty simple need.

I wanted a quick checker for real websites, especially the large messy ones with hundreds of listing pages, redirects, URL variants, and sections you do not want to crawl fully. I also did not want to keep leaning on paid tools or outsourced web tools for something that was specific to the kind of review work I was already doing.

So this project became a small crawler and audit tool that I could shape around the problems I kept seeing.

It is a React frontend with a Node backend. The frontend starts a crawl job, polls for progress, and then turns the results into grouped reports. The backend does the crawling, stays on one host, respects `robots.txt`, starts from sitemap discovery when possible, and applies rules like exclude paths, path limits, query handling, broken-link checks, redirect review, parameter audit, soft-failure review, and URL pattern grouping.

What I still find most interesting about it is that it is not just trying to answer one question.

It is not only “are there broken links?”

It is also:

- where are redirects getting messy
- where are query parameters being dropped or handled badly
- which pages return `200` but still look broken
- where is a site producing duplicate-looking URL structures
- which problems probably matter more because they repeat or touch core flows

That combination matters more on big sites than on small ones.

On a large site, especially one with a lot of listing pages, search pages, jobs pages, filters, country or language paths, and old legacy redirects, a normal click-through is not enough. You need some way to crawl fast, ignore noisy sections, cap sections that explode, and still get something readable back at the end.

That is a big part of why this project has exclude paths, path-based crawl caps, optional job-page suppression, presets, and a bookmarklet launcher. I was trying to make it useful on the kinds of sites where one bad section can flood the whole result set.

## What is interesting about the project

The part I like most is that it stays quite practical.

It does not pretend to be a giant all-purpose testing platform. It takes a site URL, runs a crawl, and gives you grouped results you can actually work through.

A few parts stand out to me:

### 1. It was built for large, noisy sites

This is probably the main thing.

The project is clearly shaped around sites with lots of repeated templates and large listing areas. The path limits, exclude rules, and “ignore job pages” option are not decorative. They are there because some sections of a site can drown the crawl if you do not control them.

That makes the tool much more useful for real teams working on career sites, large content estates, or any site with lots of repeated listing structures.

### 2. It does more than link checking

Basic link checking is useful, but it is not enough.

Cat Crawler also looks at redirect chains, parameter handling, soft failures, duplicate URL patterns, legacy/current path pairs, and issue impact. That makes it more useful during launches, migration work, cleanup work, and regression checking.

### 3. The bookmarklet is small but useful

The bookmarklet does not do the crawl itself. It opens the app in a floating panel and passes the current page URL into it.

I like that because it keeps the heavy work in the app and backend, but still gives the person using it a very quick way to start from the page they are already looking at.

### 4. It tries to keep output readable

A lot of crawl tools dump a pile of URLs and leave it there.

This one at least tries to group the work into clearer sections: audit report, validation report, redirect audit, parameter audit, soft failures, URL patterns, issue impact, and duplicate content candidates. That makes it easier to review with a team instead of handing someone a raw export and wishing them luck.

### 5. It is honest about limits

The README is actually clear on this, and I think that helps.

It only crawls one host per run. Soft-failure detection is heuristic. Pattern and impact analysis help with review, but they do not replace judgement. That is the right tone for this kind of tool.

## What I learned building it

I learned a few things pretty quickly.

### A quick checker stops being quick once a site gets big

The original instinct was speed. Just give me a quick way to spot problems.

That works up to a point. Then the site gets bigger, the listing sections get noisier, the redirects get stranger, and the result set becomes useless unless the tool has some idea of scope. That is where exclude paths, path caps, presets, and grouped reporting stopped being “nice to have” and became basic survival.

### A `200` page can still be broken

This seems obvious, but it matters.

A page can return success and still be bad because the content did not load, an API failed, or the page is showing error text inside a successful response. That is why the soft-failure work matters. It is not perfect, but it points at something simple status checks miss all the time.

### Teams do not need more output, they need better sorting

Once there is enough data, the question changes.

It is no longer “did we find enough?”

It becomes “can anyone make sense of this without wasting half a day?”

That is where grouped reports, impact hints, presets, and section-specific views become more useful than just collecting more rows.

### Big sites need deliberate exclusions

You cannot treat every part of a site equally.

Some sections are worth crawling deeply. Some should be capped. Some should be skipped unless you are checking them on purpose. The tool became better once that was treated as part of the job instead of as an awkward extra.

### The tool needs to fit how people already work

The bookmarklet piece reminded me of this.

People are already on a page when they realise they want to check something. Starting from that real page matters. Saving presets matters too, because teams repeat similar checks over and over.

## Five improvements I would make next

There is already a roadmap in the docs, and I think it points in the right direction. If I were carrying this further, these are the five improvements I would care about most.

### 1. Crawl history and compare mode

This would be one of the most useful additions for real teams.

Being able to rerun a previous crawl and compare it against an earlier run would make release checking much stronger. It would help answer the question people actually ask after a deploy: what changed, what got better, and what got worse?

### 2. Better deduping and clearer issue ranking

Large sites repeat the same problem many times.

The tool already has impact analysis, but I would push this further. Better collapse repeated issues, show stronger grouping, and make it easier to tell which problems are noise and which ones actually deserve attention first.

### 3. Better section summaries for listing-heavy sites

This project is clearly aimed at large sites with repeated listing structures, so I would lean into that more.

I would want section-level summaries that tell a team, for example, how `/jobs`, `/blog`, or `/locations` behaved as a group instead of making them read page-by-page output first.

### 4. Shareable report views for teams

Right now exports help, but I think this could go further.

A cleaner shareable report view would make handoff easier for QA, developers, SEO people, content teams, and project managers. It would be better if people could open one view and see the grouped findings without having to pass raw files around.

### 5. Stronger page context for failures

This one matters because a URL on its own is often not enough.

I would want better page context around issues: stronger clues about the page type, the template pattern, the title, the source of the bad link, and why the tool thinks something matters. That would cut review time a lot on large sites.

## How this serves teams

I think the clearest value of Cat Crawler is that it helps different people look at the same site from slightly different angles without needing a different tool for each one.

For QA teams, it helps with launch checks, regression passes, redirect review, and broken-path review.

For developers, it helps spot route problems, dropped parameters, repeated bad patterns, and sections that need cleaner rules.

For SEO or content teams, it helps surface duplicate-looking paths, legacy/current path mismatches, redirect problems, and weak sections of site structure.

For project teams, the presets and grouped reports help turn repeat checks into something less manual.

That is probably the main thing I would say about the project now. It started as a quick checker, but it became more useful once it stopped trying to crawl everything blindly and started helping people work through large, messy sites in a more controlled way.

## What I still like about it

I still like that it is very direct.

Open the app. Start a crawl. Control the noisy sections. Review the grouped output. Export if needed. Use the bookmarklet if you are already on the page you want to start from.

That is a good shape for this kind of tool.

It is not trying to do everything. It is trying to be useful where big public sites usually get messy.
