'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface
      .addColumn('Updates', 'updateNotificationAudience', {
        type: Sequelize.STRING,
        defaultValue: null,
      })
      .then(() => {
        return queryInterface.addColumn('UpdateHistories', 'updateNotificationAudience', {
          type: Sequelize.STRING,
          defaultValue: null,
        });
      });
  },

  down: async (queryInterface, Sequelize) => {
    await queryInterface.removeColumn('Updates', 'updateNotificationAudience').then(() => {
      queryInterface.removeColumn('UpdateHistories', 'updateNotificationAudience');
    });
  },
};
