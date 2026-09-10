/**
 * Responsibility: verify the deployed scaffold identity without org data or side effects.
 * These smoke tests do not claim any brief C10 product acceptance test.
 */
@IsTest
private class KusanyaRuntimeTest {
    @IsTest
    static void reportsScaffoldVersionWithoutDataAccess() {
        Integer queriesBefore = Limits.getQueries();
        Integer dmlBefore = Limits.getDmlStatements();
        Assert.areEqual('0.0.0', KusanyaRuntime.version());
        Assert.areEqual(
            queriesBefore,
            Limits.getQueries(),
            'Identity must not query tenant data'
        );
        Assert.areEqual(
            dmlBefore,
            Limits.getDmlStatements(),
            'Identity must not mutate org data'
        );
    }
}
