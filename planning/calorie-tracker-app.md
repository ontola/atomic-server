# Calorie Tracker App

Tracking calories is one of the most important things to do when trying to lose/gain weight.
However, it is often difficult to create a habit out of it since it's usually a tedious process.

This document proposes a solution to streamline the process and reduce the friction as much as possible.

## The process

- Right before the user eats or drinks something, they open an (native) app on their phone and take a picture of the food or drink.
- The app then uses a LLM to identify the food and give an estimated calorie count (incl. lower & upper bound).
- The user can wait for the info to be shown or quit the app right after taking a picture.
- The calorie count gets saved to an atomic database.
- If the LLM is unsure about the food it can schedule a notification to the user to ask for more information.

## The app

The app will be a native app for iOS and Android using Flutter.
The main screen should directly focus on logging the meal.
It should startup quick and immidiatly load the camera view.
On the same screen should also be a button to switch to the keyboard input view and to go to settings/history.

## The database

The database will be an atomic database using the atomicdata flutter library.
In the onboarding flow the user will be asked if they want a new agent or use an existing atomic agent.

## The LLM

The LLM will user selectable via OpenRouter.
The user will have to login with OpenRouter to get an API key using OAUTH.

## User stories

- The user wants to quickly log a meal or drink by taking a picture.
- The user might want to log a meal or drink by typing the name and amount instead.
- The user wants to see a summary of their calorie intake for the day.
- The user wants to see a history of their calorie intake.
- The user can share the data with a health tracking app like Apple Health or Google Fit.

## Technical

There will be **no** backend server. All data will be stored locally on the device and can be synced via atomic data's sync functionality.

## Soft requirements

- The app should be fast and responsive.
- The barrier to entry should be as low as possible. On startup the user should be able to snap a picture and close the app right after.

## Open questions

- Can we process the information on the background when the app is not running?
