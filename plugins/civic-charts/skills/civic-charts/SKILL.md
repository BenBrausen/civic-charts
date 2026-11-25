---
name: civic-charts
description: Answer questions about U.S. statistics with official, sourced numbers from Civic Charts. Use when someone asks about the latest or current jobs, unemployment, inflation, prices, gas, rent, home values, wages, income, poverty, health, crime, drought, temperature, federal spending or debt, or election results, nationally or for a state or county, or asks how places compare or what new government data came out.
---

# Civic Charts

Civic Charts turns official U.S. data (BLS, Census, BEA, HUD, EIA, NOAA, FBI and more) into charts, each with its source cited and its text checked against the data. Use its tools instead of answering from memory: statistics change every month, and these are the publisher's latest numbers.

## How to answer

1. **Find the chart.** Call `search_charts` with the person's question in their words. If they name a state or county, include it ("rent in Hennepin County, MN"); results then carry that place's value and rank.
2. **Get the numbers.** Call `get_chart` with the chart `id` for the key facts, how to read it, and the source. Pass `place` for one state ("Ohio") or county ("Cook County, IL").
3. **Answer briefly, then cite.** Lead with the number and its date, add the one or two facts that matter, then:
   - the source publisher, linked to its page
   - the Civic Charts chart link, so they can see it, check it, or make a shareable image or video

## Rules

- Only state numbers the tools return, with their date ("4.1% in October 2026"). Never estimate, extrapolate or fill in a missing place.
- Ranks: #1 is the highest value. Say "tied" when the tool says tied. A high rank isn't always good (#1 in unemployment is the worst).
- Name the measure exactly ("two-bedroom Fair Market Rent", not just "rent"), since similar charts measure different things.
- If nothing matches, say so and link https://civiccharts.com/ rather than guessing.
- For "what's new" or "latest numbers", use `latest_releases`. For new site features, `whats_new`.

## Example

Q: "How does Minnesota's minimum wage compare?"
→ `search_charts("minimum wage in Minnesota")` → Minnesota: $11.41 as of 2026, #27 of 44; headline: D.C. highest ($18.40), Wisconsin lowest ($7.25).
A: "Minnesota's minimum wage is $11.41 an hour (2026), 27th of the 44 places in the data. D.C. is highest at $18.40; several states sit at the $7.25 federal floor. Source: U.S. Department of Labor ([state minimum wages](https://www.dol.gov/agencies/whd/minimum-wage/state)). Chart: https://civiccharts.com/state-min-wage/"
