// Keeps `yarn pack` (and so tsdown's attw/publint, which pack the package) from walking
// huge directories that never ship.
//
// Yarn's pack walks the whole workspace and only prunes a directory when it is on the
// global "yarn paths" reject list: `files` / `.npmignore` are matched per file, so they do
// not stop it from descending into `vendor/` (~80k files) or `target/` (tens of GB).
// `populateYarnPaths` is the hook that feeds that reject list.
const IGNORED = ['vendor', 'target'];

module.exports = {
  name: 'plugin-pack-ignore',
  factory: () => ({
    hooks: {
      populateYarnPaths(project, definePath) {
        for (const dir of IGNORED) definePath(`${project.cwd}/${dir}`);
      },
    },
  }),
};
